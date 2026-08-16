// app/api/webhooks/hostex/[token]/route.ts
// ============================================================================
// Inbound Hostex webhooks.
//
// A DEDICATED route rather than the generic app/api/webhooks/[provider] one —
// the third such case after Stripe and Telnyx — for a reason that is structural
// rather than stylistic: the generic route's IntegrationProvider.validateWebhook
// receives only the Request, and Hostex's credential is PER CONNECTION. There
// is nothing app-wide to check a delivery against, so authentication cannot
// happen until the connection is resolved, and the connection is identified by
// this route's own path segment.
//
// ── The 3-SECOND, ZERO-RETRY budget ─────────────────────────────────────────
//
// Hostex requires an acknowledgement within 3 seconds and, unlike every other
// provider in this codebase, DOES NOT RETRY a delivery that misses it. A slow
// ack is not a delayed event, it is a lost one. So this handler does the
// minimum that cannot be deferred — resolve, authenticate, enqueue — and hands
// everything else to Inngest. No API calls, no upserts, no turnover
// generation happen here.
//
// The same property is why there is no processed_webhooks dedup claim. That
// pattern exists to absorb provider RETRIES, which Hostex does not perform;
// adding it would spend part of a 3-second budget on a round trip guarding
// against something the provider documents itself as never doing, and would
// introduce the claim-then-throw hazard that
// unit/guardrails/webhook-dedup-claim-release.test.ts exists for. Duplicate
// safety instead lives where it is free: the handler upserts on
// (org_id, external_id, external_source) and booking/confirmed dedups on
// source_reference_id.
//
// A delivery genuinely lost — dropped, mis-signed, arriving during a deploy —
// is recovered by hostexReservationReconcileCron the next morning. That cron
// was built when it was the only sync; it is now the backstop it looks like.
// ============================================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'

import { createServiceClient } from '@/lib/supabase/server'
import { inngest }             from '@/lib/inngest/client'
import { reportError }         from '@/lib/observability/report-error'
import { unwrap }              from '@/lib/supabase/unwrap'
import type { HostexWebhookPayload } from '@/lib/integrations/providers/hostex.types'

/** Hostex's own header name for the per-webhook-URL secret. */
const SECRET_HEADER = 'Hostex-Webhook-Secret-Token'

/** Events worth waking a function for. Anything else is acknowledged and dropped. */
const ACTIONABLE_EVENTS = new Set(['reservation_created', 'reservation_updated'])

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Constant-time compare of two hex digests.
 *
 * Node's timingSafeEqual throws on a length mismatch, which would itself be a
 * timing signal — but both operands here are SHA-256 hex of fixed length, so
 * the guard is a correctness check, not a leak.
 */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return nodeTimingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // Never echo the token, the secret, or the payload back to the caller. Every
  // failure below is the same opaque 401/404 — a distinguishable response would
  // let someone probe which half of the credential pair they got right.
  const providedSecret = request.headers.get(SECRET_HEADER)

  if (!token || !providedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient({ publicSurface: 'api-webhooks-hostex' })

  // ── 1. Resolve the connection from the URL ────────────────────────────────
  // The token is the routing key AND the tenant boundary — webhook_token has a
  // unique index, so this can match at most one connection.
  const connRes = await supabase
    .from('integration_connections')
    .select('user_id, org_id, status, webhook_secret_hash')
    .eq('webhook_token', token)
    .eq('provider_id', 'hostex')
    .maybeSingle()

  const connection = unwrap(connRes, { site: 'webhook.hostex.resolve-connection' })

  if (connection?.status !== 'active' || !connection.org_id) {
    // Includes the revoked/disconnected case: Hostex has no way for us to
    // deregister on their side reliably, so deliveries can outlive a
    // disconnect. Rejecting is correct; it is not worth reporting.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 2. Authenticate: trust-on-first-use ───────────────────────────────────
  // Hostex returns the secret from NO API — not POST /webhooks, not GET
  // /webhooks — so the first delivery is the only place it can ever be
  // learned. The window this opens is bounded by the token: an attacker would
  // have to know a 32-byte URL segment that only ever travelled to Hostex, and
  // beat the provider's own first delivery to it.
  const providedHash = sha256(providedSecret)

  if (!connection.webhook_secret_hash) {
    // Claim the secret ATOMICALLY. The `is('webhook_secret_hash', null)` filter
    // is what makes two simultaneous first deliveries settle on one value
    // instead of racing: the loser's update matches no row, and it then
    // re-reads and compares like any later delivery.
    const claimRes = await supabase
      .from('integration_connections')
      .update({ webhook_secret_hash: providedHash, updated_at: new Date().toISOString() })
      .eq('webhook_token', token)
      .is('webhook_secret_hash', null)
      .select('user_id')
      .maybeSingle()

    const claimed = unwrap(claimRes, { site: 'webhook.hostex.claim-secret' })

    if (!claimed) {
      // Someone else claimed it between the read and the write — re-read and
      // fall through to a normal comparison rather than trusting this one.
      const recheckRes = await supabase
        .from('integration_connections')
        .select('webhook_secret_hash')
        .eq('webhook_token', token)
        .maybeSingle()

      const recheck = unwrap(recheckRes, { site: 'webhook.hostex.recheck-secret' })

      if (!recheck?.webhook_secret_hash || !hashesMatch(recheck.webhook_secret_hash, providedHash)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    } else {
      console.log(`[Webhook:hostex] Captured webhook secret on first delivery for user ${connection.user_id}`)
    }
  } else if (!hashesMatch(connection.webhook_secret_hash, providedHash)) {
    // A mismatch is either a forgery or a secret Hostex rotated. Reported
    // rather than only logged: a connection whose deliveries are 100% rejected
    // looks exactly like one receiving none, which is how Hospitable's
    // webhooks were dead from the day they were configured.
    reportError(new Error('Hostex webhook secret mismatch'), {
      site:  'webhook.hostex.secret-mismatch',
      orgId: connection.org_id,
    })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 3. Parse ──────────────────────────────────────────────────────────────
  let payload: HostexWebhookPayload
  try {
    payload = await request.json() as HostexWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const event = typeof payload.event === 'string' ? payload.event.slice(0, 100) : ''

  // Hostex explicitly warns that payloads may gain fields and that consumers
  // must ignore what they do not recognise rather than reject the delivery —
  // so an unknown event is a 200, not a 400.
  if (!ACTIONABLE_EVENTS.has(event)) {
    return NextResponse.json({ received: true, ignored: event || 'unknown' }, { status: 200 })
  }

  if (!payload.reservation_code) {
    // Actionable event with no identity to act on. Worth reporting: it means
    // the payload contract changed under us.
    reportError(new Error(`Hostex ${event} delivery carried no reservation_code`), {
      site:  'webhook.hostex.missing-reservation-code',
      orgId: connection.org_id,
    })
    return NextResponse.json({ received: true, ignored: 'no_reservation_code' }, { status: 200 })
  }

  // ── 4. Hand off and acknowledge ───────────────────────────────────────────
  await inngest.send({
    name: 'integration/hostex.webhook.received',
    data: {
      user_id:          connection.user_id,
      org_id:           connection.org_id,
      event,
      reservation_code: payload.reservation_code,
      property_id:      payload.property_id !== undefined ? String(payload.property_id) : null,
    },
  })

  return NextResponse.json({ received: true }, { status: 200 })
}
