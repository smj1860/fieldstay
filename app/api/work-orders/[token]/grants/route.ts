import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'
import { resolvePortalToken, PORTAL_FAILURES } from '@/lib/work-orders/portal-token'
import {
  mintTechnicianGrant,
  revokeTechnicianGrant,
  listTechnicianGrants,
  GRANT_FAILURES,
  MAX_TECHNICIAN_NAME,
} from '@/lib/work-orders/tech-grants'

/**
 * The vendor forwards a work order to one of his technicians.
 *
 * POST mints a link, GET lists the live ones, DELETE revokes one. All three are
 * VENDOR ONLY, enforced inside `lib/work-orders/tech-grants.ts`: a technician
 * holding a forwarded grant must not mint further grants, or a bounded,
 * revocable, per-job credential becomes an unbounded chain the vendor cannot
 * see.
 *
 * Nothing here sends a message. The response carries a link for the vendor to
 * copy into his own text or group chat, and the technician supplies his own
 * name and (optionally) his own mobile when he opens it. See the module header
 * for why that ordering is the design rather than a shortcut.
 */

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
}

async function throttle(request: NextRequest, key: string): Promise<NextResponse | null> {
  // Abuse limiter, so it fails OPEN. A Redis outage must not stop a vendor
  // getting his technician onto a job.
  const decision = await checkLimit(
    workOrderRatelimit,
    `grants:${key}:${extractClientIp(request) ?? 'unknown'}`,
    { onError: 'allow', site: `route.work-orders.grants.${key}` },
  )
  return decision.allowed
    ? null
    : NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
}

async function resolve(token: string, site: string) {
  const supabase = createServiceClient({ publicSurface: 'vendor-portal' })
  const resolved = await resolvePortalToken(supabase, token, site)
  if (!resolved.ok) {
    const failure = PORTAL_FAILURES[resolved.reason]
    return { ok: false as const, response: NextResponse.json({ error: failure.message }, { status: failure.status }) }
  }
  // Destructured rather than spread: `resolved` carries its own `ok: true`,
  // and spreading it after one here silently overwrites it.
  return { ok: true as const, supabase, principal: resolved.principal, workOrder: resolved.workOrder }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const limited = await throttle(request, 'list')
  if (limited) return limited

  const r = await resolve(token, 'route.work-orders.grants.list')
  if (!r.ok) return r.response

  // A technician may not enumerate the other people on the job.
  if (r.principal.kind !== 'vendor') {
    const failure = GRANT_FAILURES.not_vendor
    return NextResponse.json({ error: failure.message }, { status: failure.status })
  }

  const grants = await listTechnicianGrants(r.supabase, r.workOrder)
  return NextResponse.json({ grants })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const limited = await throttle(request, 'mint')
  if (limited) return limited

  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    // An empty body is fine: the label is optional, since the technician names
    // himself on first open.
    body = {}
  }

  const raw = (body ?? {}) as Record<string, unknown>
  const rawLabel = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (rawLabel.length > MAX_TECHNICIAN_NAME) {
    return NextResponse.json({ error: `Keep the name under ${MAX_TECHNICIAN_NAME} characters.` }, { status: 400 })
  }

  const r = await resolve(token, 'route.work-orders.grants.mint')
  if (!r.ok) return r.response

  try {
    const minted = await mintTechnicianGrant(
      r.supabase, r.workOrder, r.principal, rawLabel || null,
    )
    if (!minted.ok) {
      const failure = GRANT_FAILURES[minted.reason]
      return NextResponse.json({ error: failure.message }, { status: failure.status })
    }

    return NextResponse.json({
      ok:         true,
      grant_id:   minted.value.id,
      // The link the vendor copies. Covered by proxy.ts's existing
      // '/work-orders/' TOKEN_ROUTES prefix and its workOrderRatelimit branch,
      // both startsWith matches, so this nested path needs no proxy change.
      url:        `${appUrl()}/work-orders/t/${minted.value.token}`,
      expires_at: minted.value.expiresAt,
    })
  } catch (err) {
    reportError(err, { site: 'route.work-orders.grants.mint', orgId: r.workOrder.org_id })
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const limited = await throttle(request, 'revoke')
  if (limited) return limited

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 })
  }

  const grantId = (body as Record<string, unknown>)?.grant_id
  if (typeof grantId !== 'string' || !grantId) {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 })
  }

  const r = await resolve(token, 'route.work-orders.grants.revoke')
  if (!r.ok) return r.response

  try {
    const revoked = await revokeTechnicianGrant(r.supabase, r.workOrder, r.principal, grantId)
    if (!revoked.ok) {
      const failure = GRANT_FAILURES[revoked.reason]
      return NextResponse.json({ error: failure.message }, { status: failure.status })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    reportError(err, { site: 'route.work-orders.grants.revoke', orgId: r.workOrder.org_id })
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }
}
