import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { reportError } from '@/lib/observability/report-error'
import { inngest } from '@/lib/inngest/client'
import {
  resolvePortalToken,
  PORTAL_FAILURES,
} from '@/lib/work-orders/portal-token'
import {
  acceptWorkOrder,
  declineWorkOrder,
  VENDOR_RESPONSE_FAILURES,
} from '@/lib/work-orders/vendor-response'
import { isVendorDeclineReason, type VendorDeclineReason } from '@/lib/work-orders/vendor-progress'
import type { VendorScheduledWindow } from '@/types/database'

/**
 * The vendor's answer to a dispatch: accept with a date, or decline with a
 * reason.
 *
 * ONE route for both, because they are the two halves of a single question and
 * splitting them would let a vendor hold both states at once if the second call
 * raced the first. `lib/work-orders/vendor-response.ts` owns the writes; this
 * handler validates the wire shape and nothing else.
 *
 * Unauthenticated and token-gated. `/api/work-orders` is already in
 * `proxy.ts`'s TOKEN_ROUTES (a `startsWith` match, so this nested path is
 * covered) and `rateLimiterForPathname` already returns `workOrderRatelimit`
 * for that prefix, so the per-IP throttle applies without a proxy change. The
 * inline limiter below is the second layer the other token routes also carry.
 */

const MAX_NOTE = 300

/** How far ahead a vendor may schedule. A year of slack, but not unbounded. */
const MAX_SCHEDULE_DAYS_AHEAD = 365

const VALID_WINDOWS = new Set<VendorScheduledWindow>([
  'morning', 'afternoon', 'evening', 'all_day', 'exact',
])

type Parsed =
  | { action: 'accept'; scheduledAt: string; window: VendorScheduledWindow }
  | { action: 'decline'; reason: VendorDeclineReason; note: string | null }
  | { error: string }

function asDeclineReason(value: unknown): VendorDeclineReason | null {
  return isVendorDeclineReason(value) ? value : null
}

/**
 * Validates the appointment instant.
 *
 * A date in the past is rejected rather than accepted-and-ignored: it would
 * leave the work order reading as scheduled for a visit that cannot happen,
 * which is worse than an error the vendor can correct. An unparseable value is
 * the same class — `new Date('nonsense')` is Invalid Date, and every
 * comparison against it is false, so an unchecked value would sail through
 * both bounds.
 */
function parseScheduledAt(raw: unknown): { value: string } | { error: string } {
  if (typeof raw !== 'string' || !raw) return { error: 'Pick a date you can be there.' }

  const when = new Date(raw)
  if (Number.isNaN(when.getTime())) return { error: 'That date could not be read. Please pick it again.' }

  // Midnight today, not "now": a vendor accepting at 2pm for a 9am arrival the
  // same day is doing something normal, and comparing against the instant
  // would reject it.
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  if (when < startOfToday) return { error: 'That date is in the past. Please pick a date from today onward.' }

  const ceiling = new Date()
  ceiling.setDate(ceiling.getDate() + MAX_SCHEDULE_DAYS_AHEAD)
  if (when > ceiling) return { error: 'That date is too far ahead. Please pick one within the next year.' }

  return { value: when.toISOString() }
}

function parseBody(body: unknown): Parsed {
  if (!body || typeof body !== 'object') return { error: 'Malformed request.' }
  const r = body as Record<string, unknown>

  if (r.action === 'accept') {
    const scheduled = parseScheduledAt(r.scheduled_at)
    if ('error' in scheduled) return { error: scheduled.error }

    const window = r.window
    if (typeof window !== 'string' || !VALID_WINDOWS.has(window as VendorScheduledWindow)) {
      return { error: 'Pick an arrival window.' }
    }

    return { action: 'accept', scheduledAt: scheduled.value, window: window as VendorScheduledWindow }
  }

  if (r.action === 'decline') {
    const reason = asDeclineReason(r.reason)
    if (!reason) return { error: 'Pick a reason so the property manager knows what to do next.' }

    const rawNote = typeof r.note === 'string' ? r.note.trim() : ''
    if (rawNote.length > MAX_NOTE) return { error: `Keep the note under ${MAX_NOTE} characters.` }

    return { action: 'decline', reason, note: rawNote || null }
  }

  return { error: 'Malformed request.' }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // Abuse/enumeration limiter, so it fails OPEN: a Redis outage must not stop
  // a vendor answering a dispatch.
  const decision = await checkLimit(
    workOrderRatelimit,
    `respond:${extractClientIp(request) ?? 'unknown'}`,
    { onError: 'allow', site: 'route.work-orders.respond' },
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

  const resolved = await resolvePortalToken(supabase, token, 'route.work-orders.respond')
  if (!resolved.ok) {
    const failure = PORTAL_FAILURES[resolved.reason]
    return NextResponse.json({ error: failure.message }, { status: failure.status })
  }

  const { principal, workOrder } = resolved

  try {
    if (parsed.action === 'accept') {
      const result = await acceptWorkOrder(supabase, workOrder, principal, {
        scheduledAt: parsed.scheduledAt,
        window:      parsed.window,
      })
      if (!result.ok) {
        const failure = VENDOR_RESPONSE_FAILURES[result.reason]
        return NextResponse.json({ error: failure.message }, { status: failure.status })
      }
      return NextResponse.json({
        ok:              true,
        scheduled_at:    parsed.scheduledAt,
        window:          parsed.window,
        after_needed_by: result.value.afterNeededBy,
      })
    }

    const result = await declineWorkOrder(supabase, workOrder, principal, {
      reason: parsed.reason,
      note:   parsed.note,
    })
    if (!result.ok) {
      const failure = VENDOR_RESPONSE_FAILURES[result.reason]
      return NextResponse.json({ error: failure.message }, { status: failure.status })
    }

    // Fired AFTER the write committed, so a failed send cannot leave the work
    // order declined in the vendor's view and still dispatched in the PM's.
    // The handler records the decline, tells the PM, and re-runs the existing
    // scorer for a suggestion. It never auto-dispatches.
    await inngest.send({
      name: 'work-order/vendor-declined',
      data: {
        work_order_id: workOrder.id,
        property_id:   workOrder.property_id,
        org_id:        workOrder.org_id,
        vendor_id:     result.value.vendorId,
        reason:        parsed.reason,
        note:          parsed.note,
        category:      workOrder.category,
        stage:         result.value.stage,
      },
    })

    return NextResponse.json({ ok: true, declined: true })
  } catch (err) {
    reportError(err, { site: 'route.work-orders.respond', orgId: workOrder.org_id })
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }
}
