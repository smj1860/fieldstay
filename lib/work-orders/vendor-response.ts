import 'server-only'

import type { createServiceClient } from '@/lib/supabase/server'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import { createPmNotification } from '@/lib/inngest/helpers'
import {
  woStatusForProgress,
  releasesVendor,
  blocksOnPm,
  vendorProgressLabel,
  vendorDeclineReasonLabel,
  type VendorProgress,
  type VendorDeclineReason,
} from '@/lib/work-orders/vendor-progress'
import type { PortalPrincipal, PortalWorkOrder } from '@/lib/work-orders/portal-token'
import type { VendorScheduledWindow, WoStatus } from '@/types/database'

/**
 * The vendor's three writes: accept (which IS setting the date), decline, and a
 * progress change. One module, because all three share the parts that must not
 * be re-decided per route — the `wo_status` mapping, the `work_order_updates`
 * audit row, and who gets told.
 *
 * ACCEPT IS THE DATE. There is no accepted-but-unscheduled state, deliberately:
 * one would need its own nudge ("accepted three days ago, no appointment set")
 * and would just move the silence one step later. So acceptance and the
 * appointment are a single write, and `appointment_scheduled` is its
 * consequence rather than something anybody selects.
 *
 * `job_completed` is NOT reachable from here. Completion goes through
 * `finalizeWorkOrderCompletion()`, which carries the `work-order/completed`
 * event (and so the owner P&L expense), `completed_date`, the update row and
 * the source-schedule advance with it. A second completion path that wrote
 * `status: 'completed'` directly would skip every one of those.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

export type VendorResponseFailure =
  | 'unavailable'
  | 'already_closed'
  | 'not_dispatched'
  | 'not_accepted'
  | 'stale'

export const VENDOR_RESPONSE_FAILURES: Record<VendorResponseFailure, { status: number; message: string }> = {
  unavailable:    { status: 503, message: 'Service temporarily unavailable. Please try again.' },
  already_closed: { status: 409, message: 'This work order is already closed.' },
  not_dispatched: { status: 409, message: 'This work order is no longer assigned to you.' },
  not_accepted:   { status: 409, message: 'Accept this work order before updating its progress.' },
  // The claim below is a filtered UPDATE, so losing it means somebody else got
  // there first. A retry would be wrong, which is why this is its own reason
  // rather than folded into `unavailable`.
  stale:          { status: 409, message: 'This work order changed while you were working. Reload and try again.' },
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: VendorResponseFailure }

const CLOSED: ReadonlySet<WoStatus> = new Set(['completed', 'cancelled'])

/**
 * The audit row every one of these writes leaves behind.
 *
 * `updated_via_vendor_portal` is true for both principals: a technician holding
 * a forwarded grant is still the vendor side of the job, not a PM. Who
 * specifically did it lives in the note, since `work_order_updates` has no
 * grant column and inventing one would mean a migration for a string.
 */
async function recordUpdate(
  supabase:  ServiceClient,
  workOrder: PortalWorkOrder,
  principal: PortalPrincipal,
  statusFrom: WoStatus | null,
  statusTo:   WoStatus | null,
  note:       string,
): Promise<void> {
  const who = principal.kind === 'technician'
    ? `${principal.displayName ?? 'Technician'} (technician)`
    : 'Vendor'

  const { error } = await supabase.from('work_order_updates').insert({
    work_order_id:             workOrder.id,
    org_id:                    workOrder.org_id,
    updated_by_user_id:        null,
    updated_via_vendor_portal: true,
    status_from:               statusFrom,
    status_to:                 statusTo,
    notes:                     `${who}: ${note}`,
  })

  // Reported, never thrown. The state change itself already landed, and
  // failing the request here would tell the vendor their update did not go
  // through while it demonstrably did — then they would do it again. A missing
  // audit row is the lesser loss, and it is visible in Sentry rather than
  // silent.
  if (error) {
    reportError(error, {
      site:  'lib.work-orders.vendor-response.recordUpdate',
      orgId: workOrder.org_id,
      level: 'warning',
    })
  }
}

/**
 * The fields to write whenever a vendor is attached to a work order.
 *
 * Starts the dispatch-silence clock and clears any PREVIOUS vendor's response.
 * Both matter on a RE-dispatch: the new vendor has not answered, so leaving
 * `vendor_progress` set would show the PM a declined or in-flight state
 * belonging to somebody who is no longer on the job, and leaving
 * `vendor_dispatched_at` untouched would measure the new vendor's silence from
 * when the old one was asked.
 *
 * Belongs on the UNCONDITIONAL vendor write at each dispatch site, not on the
 * filtered status advance beside it. That advance is scoped to
 * `['pending','quote_requested']` so the status only moves forward, which means
 * re-dispatching an already-assigned work order skips it entirely, and the
 * clock would never restart for exactly the case that most needs it.
 *
 * Pure, so the three call sites spread it into their existing payloads rather
 * than issuing a fourth statement.
 */
export function vendorDispatchFields(now = new Date().toISOString()) {
  return {
    vendor_dispatched_at:    now,
    vendor_progress:         null,
    vendor_progress_at:      null,
    vendor_progress_note:    null,
    vendor_accepted_at:      null,
    vendor_declined_at:      null,
    vendor_decline_reason:   null,
    vendor_scheduled_at:     null,
    vendor_scheduled_window: null,
  } as const
}

export interface AcceptInput {
  scheduledAt: string
  window:      VendorScheduledWindow
}

export interface AcceptOutcome {
  /** True when the appointment lands after the PM's needed-by date. */
  afterNeededBy: boolean
}

/**
 * Accept, and set the appointment, in one filtered UPDATE.
 *
 * The claim is `.in('status', ['pending','assigned','quote_requested'])` plus a
 * vendor match: an unfiltered update would let a second tab, or a technician
 * and the vendor acting at once, overwrite an appointment that was already
 * agreed. Losing the claim returns `stale` rather than retrying.
 *
 * An appointment AFTER `needed_by_date` still succeeds. The vendor's honest
 * date beats a refused form, and whether to wait or re-route is the PM's
 * decision, not the form's, so this reports the overrun and notifies them.
 */
export async function acceptWorkOrder(
  supabase:  ServiceClient,
  workOrder: PortalWorkOrder,
  principal: PortalPrincipal,
  input:     AcceptInput,
): Promise<Result<AcceptOutcome>> {
  if (CLOSED.has(workOrder.status)) return { ok: false, reason: 'already_closed' }
  if (!workOrder.vendor_id) return { ok: false, reason: 'not_dispatched' }

  const now = new Date().toISOString()

  const claimRes = await supabase
    .from('work_orders')
    .update({
      status:                  woStatusForProgress('appointment_scheduled'),
      vendor_progress:         'appointment_scheduled' satisfies VendorProgress,
      vendor_progress_at:      now,
      vendor_accepted_at:      now,
      vendor_scheduled_at:     input.scheduledAt,
      vendor_scheduled_window: input.window,
      // Cleared, not left: a work order re-dispatched after an earlier decline
      // would otherwise still carry the previous refusal and read as both
      // accepted and declined.
      vendor_declined_at:      null,
      vendor_decline_reason:   null,
    })
    .eq('id', workOrder.id)
    .eq('org_id', workOrder.org_id)
    .eq('vendor_id', workOrder.vendor_id)
    .in('status', ['pending', 'assigned', 'quote_requested'])
    .select('id, status')

  const claim = tryUnwrap(claimRes, { site: 'lib.work-orders.vendor-response.accept', orgId: workOrder.org_id })
  if (!claim.ok) return { ok: false, reason: 'unavailable' }
  if (!claim.data?.length) return { ok: false, reason: 'stale' }

  const afterNeededBy = workOrder.needed_by_date !== null
    && input.scheduledAt.slice(0, 10) > workOrder.needed_by_date

  await recordUpdate(
    supabase, workOrder, principal, workOrder.status, 'assigned',
    `accepted, scheduled for ${input.scheduledAt.slice(0, 10)} (${input.window})`,
  )

  if (afterNeededBy) {
    await notifyPm(supabase, workOrder, {
      type:     'work_order.scheduled_after_needed_by',
      title:    `Vendor scheduled after your needed-by date`,
      subtitle: `${workOrder.wo_number ?? workOrder.title} is booked for `
              + `${input.scheduledAt.slice(0, 10)}, after ${workOrder.needed_by_date}.`,
      severity: 'amber',
    })
  }

  return { ok: true, value: { afterNeededBy } }
}

export interface DeclineInput {
  reason: VendorDeclineReason
  note:   string | null
}

export interface DeclineOutcome {
  /** The vendor who declined, for the event. Cleared off the row by now. */
  vendorId: string
  /** Declining a dispatch, versus cancelling one already accepted. */
  stage:    'on_dispatch' | 'after_accepting'
}

/**
 * Decline, or cancel after accepting. Returns the work order to the UNASSIGNED
 * queue.
 *
 * `status: 'pending'` and a null `vendor_id` are what make it re-dispatchable at
 * all: `dispatchWorkOrderToVendor` advances status behind a forward-only
 * `.in('status', ['pending','quote_requested'])` filter, so any other resting
 * state would leave the work order permanently stuck with nobody assigned.
 *
 * The appointment is cleared too. Leaving a `vendor_scheduled_at` behind would
 * show the PM a confirmed visit from a vendor who is no longer on the job, and
 * the calendar reads that column.
 */
export async function declineWorkOrder(
  supabase:  ServiceClient,
  workOrder: PortalWorkOrder,
  principal: PortalPrincipal,
  input:     DeclineInput,
): Promise<Result<DeclineOutcome>> {
  if (CLOSED.has(workOrder.status)) return { ok: false, reason: 'already_closed' }
  if (!workOrder.vendor_id) return { ok: false, reason: 'not_dispatched' }

  const vendorId = workOrder.vendor_id
  const stage: DeclineOutcome['stage'] =
    workOrder.vendor_accepted_at ? 'after_accepting' : 'on_dispatch'
  const progress: VendorProgress =
    stage === 'after_accepting' ? 'cancelled_by_vendor' : 'declined'
  const now = new Date().toISOString()

  const claimRes = await supabase
    .from('work_orders')
    .update({
      status:                  woStatusForProgress(progress),
      vendor_id:               null,
      vendor_progress:         progress,
      vendor_progress_at:      now,
      vendor_progress_note:    input.note,
      vendor_declined_at:      now,
      vendor_decline_reason:   input.reason,
      vendor_accepted_at:      null,
      vendor_scheduled_at:     null,
      vendor_scheduled_window: null,
      // The dispatch clock stops. Leaving it set would have the
      // dispatch-silence timer keep nagging about a vendor who has answered.
      vendor_dispatched_at:    null,
    })
    .eq('id', workOrder.id)
    .eq('org_id', workOrder.org_id)
    .eq('vendor_id', vendorId)
    .not('status', 'in', '("completed","cancelled")')
    .select('id')

  const claim = tryUnwrap(claimRes, { site: 'lib.work-orders.vendor-response.decline', orgId: workOrder.org_id })
  if (!claim.ok) return { ok: false, reason: 'unavailable' }
  if (!claim.data?.length) return { ok: false, reason: 'stale' }

  const reasonLabel = vendorDeclineReasonLabel(input.reason)
  await recordUpdate(
    supabase, workOrder, principal, workOrder.status, 'pending',
    stage === 'after_accepting'
      ? `cancelled after accepting. Reason: ${reasonLabel}`
      : `declined. Reason: ${reasonLabel}`,
  )

  return { ok: true, value: { vendorId, stage } }
}

export interface ProgressInput {
  progress: VendorProgress
  note:     string | null
}

/**
 * A progress change mid-job.
 *
 * Requires an accepted work order: progress before acceptance is meaningless,
 * and allowing it would let a vendor skip the date entirely and still look
 * engaged, which is the exact silence the accept step exists to remove.
 *
 * The two BLOCKED states notify the PM immediately. A technician standing
 * outside a property he cannot get into, or holding a repair that exceeds the
 * NTE, is making a request, not filing a status update. Leaving that in a
 * dropdown nobody watches would reproduce the problem this whole axis is for.
 */
export async function setVendorProgress(
  supabase:  ServiceClient,
  workOrder: PortalWorkOrder,
  principal: PortalPrincipal,
  input:     ProgressInput,
): Promise<Result<{ status: WoStatus }>> {
  if (CLOSED.has(workOrder.status)) return { ok: false, reason: 'already_closed' }
  if (!workOrder.vendor_id) return { ok: false, reason: 'not_dispatched' }
  if (!workOrder.vendor_accepted_at) return { ok: false, reason: 'not_accepted' }
  // Releasing the vendor is declineWorkOrder's job, which also clears the
  // appointment and fires the re-dispatch. Routing it through here would set
  // the status and leave the work order assigned to a vendor who just quit.
  if (releasesVendor(input.progress)) return { ok: false, reason: 'not_accepted' }

  const status = woStatusForProgress(input.progress)
  const now = new Date().toISOString()

  const claimRes = await supabase
    .from('work_orders')
    .update({
      status,
      vendor_progress:      input.progress,
      vendor_progress_at:   now,
      vendor_progress_note: input.note,
    })
    .eq('id', workOrder.id)
    .eq('org_id', workOrder.org_id)
    .eq('vendor_id', workOrder.vendor_id)
    .not('status', 'in', '("completed","cancelled")')
    .select('id')

  const claim = tryUnwrap(claimRes, { site: 'lib.work-orders.vendor-response.progress', orgId: workOrder.org_id })
  if (!claim.ok) return { ok: false, reason: 'unavailable' }
  if (!claim.data?.length) return { ok: false, reason: 'stale' }

  await recordUpdate(
    supabase, workOrder, principal, workOrder.status, status,
    input.note ? `${vendorProgressLabel(input.progress)}. ${input.note}` : vendorProgressLabel(input.progress),
  )

  if (blocksOnPm(input.progress)) {
    await notifyPm(supabase, workOrder, {
      type:     'work_order.vendor_blocked',
      title:    input.progress === 'awaiting_access'
        ? 'Vendor cannot get into the property'
        : 'Vendor needs your approval to continue',
      subtitle: buildBlockedSubtitle(workOrder, input),
      severity: 'red',
    })
  }

  return { ok: true, value: { status } }
}

function buildBlockedSubtitle(workOrder: PortalWorkOrder, input: ProgressInput): string {
  const label = workOrder.wo_number ?? workOrder.title
  const detail = input.note ? ` ${input.note}` : ''
  return `${label}: ${vendorProgressLabel(input.progress)}.${detail}`
}

/**
 * Dedupe-keyed on the work order, the kind of alert and the DAY.
 *
 * A vendor tapping "waiting on access" twice in one visit must not post two
 * notifications, but the same vendor blocked again next week genuinely is new.
 * The day is what distinguishes them, and `notifications.dedupe_key` is unique
 * when non-null, so the second insert of the day is a no-op rather than a
 * duplicate the PM has to dismiss twice.
 */
async function notifyPm(
  supabase:  ServiceClient,
  workOrder: PortalWorkOrder,
  input:     { type: string; title: string; subtitle: string; severity: 'red' | 'amber' },
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  await createPmNotification(supabase, {
    orgId:     workOrder.org_id,
    type:      input.type,
    title:     input.title,
    subtitle:  input.subtitle,
    href:      `/maintenance/${workOrder.id}`,
    severity:  input.severity,
    dedupeKey: `${input.type}:${workOrder.id}:${day}`,
  })
}
