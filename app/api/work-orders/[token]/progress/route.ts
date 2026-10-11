import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'
import { resolvePortalToken, PORTAL_FAILURES } from '@/lib/work-orders/portal-token'
import { setVendorProgress, VENDOR_RESPONSE_FAILURES } from '@/lib/work-orders/vendor-response'
import {
  isVendorProgress,
  isSelectableByVendor,
  releasesVendor,
  type VendorProgress,
} from '@/lib/work-orders/vendor-progress'

/**
 * A progress change mid-job: on the way, on site, waiting on access, parts
 * ordered, and so on.
 *
 * The state machine lives in `lib/work-orders/vendor-response.ts` and the
 * `vendor_progress` -> `wo_status` mapping in
 * `lib/work-orders/vendor-progress.ts`. This handler validates the wire shape
 * and refuses the two values that are not a vendor's to pick here.
 *
 * Token-gated and unauthenticated, covered by `proxy.ts`'s existing
 * `/api/work-orders` TOKEN_ROUTES prefix and its `workOrderRatelimit` branch.
 */

const MAX_NOTE = 300

type Parsed = { progress: VendorProgress; note: string | null } | { error: string }

function parseBody(body: unknown): Parsed {
  if (!body || typeof body !== 'object') return { error: 'Malformed request.' }
  const r = body as Record<string, unknown>

  if (!isVendorProgress(r.progress)) return { error: 'Pick a status.' }

  // job_completed is not selectable: completion goes through the completion
  // form so it keeps ONE path through finalizeWorkOrderCompletion, which
  // carries the work-order/completed event (and so the owner P&L expense),
  // completed_date, the update row and the source-schedule advance with it.
  if (!isSelectableByVendor(r.progress)) {
    return { error: 'Use the completion form to close this work order out.' }
  }

  // Declining has its own endpoint, which also clears the appointment and
  // fires the re-dispatch. Accepting it here would set the status and leave
  // the work order assigned to a vendor who just quit.
  if (releasesVendor(r.progress)) {
    return { error: 'Use the decline option to hand this work order back.' }
  }

  const rawNote = typeof r.note === 'string' ? r.note.trim() : ''
  if (rawNote.length > MAX_NOTE) return { error: `Keep the note under ${MAX_NOTE} characters.` }

  return { progress: r.progress, note: rawNote || null }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // Abuse limiter, so it fails OPEN. A Redis outage must not stop a technician
  // reporting that he cannot get into a property.
  const decision = await checkLimit(
    workOrderRatelimit,
    `progress:${extractClientIp(request) ?? 'unknown'}`,
    { onError: 'allow', site: 'route.work-orders.progress' },
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

  const resolved = await resolvePortalToken(supabase, token, 'route.work-orders.progress')
  if (!resolved.ok) {
    const failure = PORTAL_FAILURES[resolved.reason]
    return NextResponse.json({ error: failure.message }, { status: failure.status })
  }

  try {
    const result = await setVendorProgress(
      supabase, resolved.workOrder, resolved.principal,
      { progress: parsed.progress, note: parsed.note },
    )
    if (!result.ok) {
      const failure = VENDOR_RESPONSE_FAILURES[result.reason]
      return NextResponse.json({ error: failure.message }, { status: failure.status })
    }
    return NextResponse.json({ ok: true, progress: parsed.progress, status: result.value.status })
  } catch (err) {
    reportError(err, { site: 'route.work-orders.progress', orgId: resolved.workOrder.org_id })
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }
}
