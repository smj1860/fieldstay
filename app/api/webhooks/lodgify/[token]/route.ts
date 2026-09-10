// app/api/webhooks/lodgify/[token]/route.ts
// ============================================================================
// Inbound Lodgify webhooks.
//
// A DEDICATED route rather than the generic app/api/webhooks/[provider] one,
// for the same structural reason Hostex has one: that route's
// IntegrationProvider.validateWebhook receives only the Request, and Lodgify
// gives it nothing app-wide to check. The connection has to be resolved before
// the delivery can be authenticated at all, and this route's own path segment
// is what identifies it.
//
// ── THE DEFENSIVE POSTURE, AND WHY ──────────────────────────────────────────
//
// Lodgify documents NO webhook signature, NO shared secret, and NO
// provider-issued verification header anywhere reachable. That could not be
// confirmed either way before shipping (docs.lodgify.com refuses automated
// fetches), so this route is written for the WORSE of the two possibilities:
// that a delivery is an entirely unauthenticated HTTP request from anyone who
// learns the URL.
//
// Three properties follow, and they are the whole design:
//
//   1. THE URL IS THE CREDENTIAL. 32 bytes of crypto randomness, minted by us,
//      that only ever travelled to Lodgify. It is also the tenant boundary —
//      webhook_token is uniquely indexed, so it can match at most one
//      connection.
//   2. THE BODY IS NEVER TRUSTED FOR FACTS. Nothing from the payload is
//      written anywhere. At most one identifier is read out of it, and every
//      fact about that booking is then re-read from Lodgify's API with our own
//      key by lodgifyWebhookHandler. A forged delivery can therefore, at
//      absolute worst, make us re-read a booking that already belongs to the
//      connection it named — it cannot inject a stay, move a date, or alter
//      revenue.
//   3. AN UNREADABLE DELIVERY STILL MEANS SOMETHING CHANGED. A body we cannot
//      parse, or one whose id field is spelled differently than
//      lodgify.types.ts guesses, falls back to a short recent-window sweep for
//      that connection instead of being dropped. This is the single most
//      important consequence of the shapes being unverified: the failure mode
//      of a wrong guess becomes "slightly more work", not "the change is lost".
//
// If Lodgify turns out to sign its deliveries, add the check here — it
// strengthens this design rather than replacing it, exactly as Hostex's
// per-connection secret sits on top of its own URL token.
//
// RATE LIMITING is already applied by proxy.ts, which matches
// '/api/webhooks/' with webhookRatelimit BEFORE the BYPASS_ROUTES
// early-return. No inline limiter here would add anything the middleware does
// not already do.
// ============================================================================

import { NextResponse, type NextRequest } from 'next/server'

import { createServiceClient } from '@/lib/supabase/server'
import { inngest }             from '@/lib/inngest/client'
import { unwrap }              from '@/lib/supabase/unwrap'
import { isSyncableConnectionStatus } from '@/lib/integrations/connection-metadata'

/**
 * Body bytes we are willing to read before parsing.
 *
 * A real Lodgify delivery is a small JSON object. This exists because the
 * route is unauthenticated until the token is checked and JSON.parse on an
 * arbitrarily large body is CPU spent on an attacker's behalf — cheap to
 * bound, and there is no legitimate delivery anywhere near this size.
 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Events with no consumer here. Acknowledged and dropped rather than rejected:
 * a 4xx to a provider that may retry buys nothing when the answer will be the
 * same next time.
 *
 * Matched loosely (substring, case-insensitive) because Lodgify's exact event
 * strings are unverified — and the cost of failing to recognise one is only
 * that it takes the booking path and re-reads a booking, which is harmless.
 */
const IGNORED_EVENT_HINTS = ['rate_change', 'guest_message', 'message_received']

/**
 * Pull a booking id out of a delivery body, if one is recognisably there.
 *
 * Tries several plausible spellings because the payload shape is unverified —
 * see lodgify.types.ts. This is NOT trusting the body: the id is used only to
 * decide WHICH booking to re-read from Lodgify with our own credential, and
 * the handler then discards anything that does not belong to this connection's
 * own properties.
 *
 * Returns null when nothing looks like an id, which is a legitimate outcome
 * and triggers the window sweep rather than a drop.
 */
function extractBookingId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null

  const body   = payload as Record<string, unknown>
  const nested = body.booking && typeof body.booking === 'object'
    ? body.booking as Record<string, unknown>
    : {}

  const candidates = [body.booking_id, body.id, nested.id, nested.booking_id]

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
    // Digits only. A free-form string here would let a delivery steer the path
    // segment of the API call the handler makes.
    if (typeof candidate === 'string' && /^\d{1,20}$/.test(candidate.trim())) return candidate.trim()
  }

  return null
}

/** The event name, when the body carries one — truncated, and only ever logged. */
function extractEvent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const event = (payload as { event?: unknown }).event
  return typeof event === 'string' ? event.slice(0, 100) : ''
}

function isIgnorableEvent(event: string): boolean {
  const lower = event.toLowerCase()
  return IGNORED_EVENT_HINTS.some((hint) => lower.includes(hint))
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // Never echo the token or the payload back to the caller. Every failure
  // below is the same opaque 401 — a distinguishable response would let
  // someone probe the token space by response shape.
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient({ publicSurface: 'api-webhooks-lodgify' })

  // ── 1. Resolve the connection from the URL ────────────────────────────────
  // The token is the routing key AND the tenant boundary — webhook_token is
  // uniquely indexed, so this matches at most one connection.
  const connRes = await supabase
    .from('integration_connections')
    .select('user_id, org_id, status')
    .eq('webhook_token', token)
    .eq('provider_id', 'lodgify')
    .maybeSingle()

  const connection = unwrap(connRes, { site: 'webhook.lodgify.resolve-connection' })

  // isSyncableConnectionStatus, NOT `status !== 'active'`. 'error' means the
  // last SYNC failed — an expired key, a 5xx, a rate-limit — and says nothing
  // about whether this delivery is genuine or whether the org still wants it.
  // Rejecting on it would mean deliveries stop precisely during the window
  // they matter most, while the daily reconcile keeps the integration looking
  // healthy. Revoked/disconnected still rejects.
  if (!connection || !isSyncableConnectionStatus(connection.status) || !connection.org_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 2. Read the body, within bounds ───────────────────────────────────────
  const raw = await request.text()

  if (raw.length > MAX_BODY_BYTES) {
    // Not parsed at all. The connection is real, so this is worth a sweep
    // rather than a drop — but nothing this size is a delivery we should read.
    await enqueue(connection.user_id, connection.org_id, 'oversized_body', null)
    return NextResponse.json({ received: true, ignored: 'oversized_body' }, { status: 200 })
  }

  let payload: unknown = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    // An authenticated delivery we cannot parse still means something changed.
    // Sweeping is the honest response; a 400 would discard the signal.
    payload = null
  }

  const event = extractEvent(payload)

  if (isIgnorableEvent(event)) {
    return NextResponse.json({ received: true, ignored: event }, { status: 200 })
  }

  // ── 3. Hand off and acknowledge ───────────────────────────────────────────
  // Only ids cross this boundary — never the payload, never the token.
  await enqueue(connection.user_id, connection.org_id, event, extractBookingId(payload))

  return NextResponse.json({ received: true }, { status: 200 })
}

async function enqueue(
  userId:    string,
  orgId:     string,
  event:     string,
  bookingId: string | null,
): Promise<void> {
  await inngest.send({
    name: 'integration/lodgify.webhook.received',
    data: {
      user_id:    userId,
      org_id:     orgId,
      event,
      // null means "we could not tell which booking" — the handler sweeps a
      // short recent window instead of re-reading one booking.
      booking_id: bookingId,
    },
  })
}
