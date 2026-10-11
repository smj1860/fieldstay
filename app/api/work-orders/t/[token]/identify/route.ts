import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'
import { resolvePortalToken, PORTAL_FAILURES } from '@/lib/work-orders/portal-token'
import { identifyTechnician, GRANT_FAILURES, MAX_TECHNICIAN_NAME } from '@/lib/work-orders/tech-grants'

/**
 * A technician names himself the first time he opens a forwarded work order,
 * and may leave his own mobile.
 *
 * This is where the vendor's roster comes from. Asked here rather than at send
 * time, the name is the one he actually goes by, the number arrives with his
 * own consent attached, and the vendor never types a phone number at all, so
 * there are no typos polluting the roster.
 *
 * The name becomes the grant's label and the attribution on every write he
 * makes, replacing the free-text "completed by" typed at the end of a
 * completion form.
 */

const MAX_PHONE_INPUT = 32

type Parsed = { name: string; phone: string | null } | { error: string }

function parseBody(body: unknown): Parsed {
  if (!body || typeof body !== 'object') return { error: 'Malformed request.' }
  const r = body as Record<string, unknown>

  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return { error: 'Enter your name so the work is recorded under it.' }
  if (name.length > MAX_TECHNICIAN_NAME) {
    return { error: `Keep your name under ${MAX_TECHNICIAN_NAME} characters.` }
  }

  // Bounded before it reaches normalization, which is a parser: an unbounded
  // string from a phone keyboard is not something to hand a parser.
  const rawPhone = typeof r.phone === 'string' ? r.phone.trim() : ''
  if (rawPhone.length > MAX_PHONE_INPUT) return { error: 'That phone number is too long.' }

  return { name, phone: rawPhone || null }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const decision = await checkLimit(
    workOrderRatelimit,
    `identify:${extractClientIp(request) ?? 'unknown'}`,
    { onError: 'allow', site: 'route.work-orders.identify' },
  )
  if (!decision.allowed) {
    return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 })
  }

  const parsed = parseBody(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const supabase = createServiceClient({ publicSurface: 'vendor-portal' })

  const resolved = await resolvePortalToken(supabase, token, 'route.work-orders.identify')
  if (!resolved.ok) {
    const failure = PORTAL_FAILURES[resolved.reason]
    return NextResponse.json({ error: failure.message }, { status: failure.status })
  }

  // Only a technician grant can be named. The vendor's own link has no grant
  // row behind it, and naming it would mean writing a roster entry for the
  // company rather than for a person.
  const { principal, workOrder } = resolved
  if (principal.kind !== 'technician' || !principal.grantId) {
    return NextResponse.json({ error: GRANT_FAILURES.not_found.message }, { status: 404 })
  }

  if (!workOrder.vendor_id) {
    return NextResponse.json({ error: GRANT_FAILURES.not_found.message }, { status: 404 })
  }

  try {
    const named = await identifyTechnician(
      supabase, principal.grantId, workOrder.org_id, workOrder.vendor_id,
      { name: parsed.name, phone: parsed.phone },
    )
    if (!named.ok) {
      const failure = GRANT_FAILURES[named.reason]
      return NextResponse.json({ error: failure.message }, { status: failure.status })
    }
    return NextResponse.json({ ok: true, name: named.value.label })
  } catch (err) {
    // Never log the phone number: PII, and a third party's employee.
    reportError(err, { site: 'route.work-orders.identify', orgId: workOrder.org_id })
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }
}
