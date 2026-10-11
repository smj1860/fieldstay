import type { WoStatus } from '@/types/database'

/**
 * The vendor-written progress axis, and its single mapping onto `wo_status`.
 *
 * WHY TWO COLUMNS. `wo_status` has six values and sixteen hardcoded
 * open-status filter lists reading it, every one a literal array
 * (`['pending','assigned','in_progress']`) in the board, `/ops`, the metrics
 * snapshot, PM notifications, the aging escalation and the inspection fan-out.
 * Widening that enum means a work order on 'parts_ordered' silently dropping
 * out of all of them unless all sixteen move in lockstep, with nothing forcing
 * it and no symptom to notice. So `wo_status` stays the coarse lifecycle the
 * platform reasons about and `vendor_progress` carries the detail.
 *
 * This module is the ONLY place the two are related. Every write path calls
 * `woStatusForProgress()` rather than deciding for itself, and
 * `unit/guardrails/vendor-progress-mapping.test.ts` asserts the map is total
 * over the enum — so a new progress value cannot be added without deciding
 * what it means for the lifecycle.
 *
 * Zero dependencies beyond a type import, so a `'use client'` vendor portal
 * component can import it.
 */

export type VendorProgress =
  | 'declined'
  | 'cancelled_by_vendor'
  | 'appointment_scheduled'
  | 'on_the_way'
  | 'tech_on_site'
  | 'awaiting_access'
  | 'hold_pm_approval'
  | 'parts_ordered'
  | 'repair_in_progress'
  | 'return_visit_scheduled'
  | 'job_completed'

export type VendorDeclineReason =
  | 'no_capacity'
  | 'outside_service_area'
  | 'not_my_trade'
  | 'price_below_minimum'
  | 'cannot_access_property'
  | 'other'

/**
 * Every value, in lifecycle order. The source of truth for the dropdown's
 * order and for the guardrail's totality check — a `Record` keyed on the union
 * would make a MISSING key a compile error but gives no runtime list to
 * iterate, and the guardrail needs one.
 */
export const VENDOR_PROGRESS_VALUES: readonly VendorProgress[] = [
  'declined',
  'cancelled_by_vendor',
  'appointment_scheduled',
  'on_the_way',
  'tech_on_site',
  'awaiting_access',
  'hold_pm_approval',
  'parts_ordered',
  'repair_in_progress',
  'return_visit_scheduled',
  'job_completed',
] as const

export const VENDOR_DECLINE_REASONS: readonly VendorDeclineReason[] = [
  'no_capacity',
  'outside_service_area',
  'not_my_trade',
  'price_below_minimum',
  'cannot_access_property',
  'other',
] as const

/**
 * The mapping. A `Record` over the union, so adding a `VendorProgress` value
 * without a lifecycle status fails to compile.
 *
 * `declined` and `cancelled_by_vendor` both return the work order to `pending`
 * rather than to a dead end: `dispatchWorkOrderToVendor` advances status behind
 * a forward-only `.in('status', ['pending','quote_requested'])` filter, so
 * `pending` is what makes the work order re-dispatchable at all. The caller
 * clears `vendor_id` alongside it.
 */
const STATUS_BY_PROGRESS: Record<VendorProgress, WoStatus> = {
  declined:               'pending',
  cancelled_by_vendor:    'pending',
  appointment_scheduled:  'assigned',
  on_the_way:             'in_progress',
  tech_on_site:           'in_progress',
  awaiting_access:        'in_progress',
  hold_pm_approval:       'in_progress',
  parts_ordered:          'in_progress',
  repair_in_progress:     'in_progress',
  return_visit_scheduled: 'in_progress',
  job_completed:          'completed',
}

export function woStatusForProgress(progress: VendorProgress): WoStatus {
  return STATUS_BY_PROGRESS[progress]
}

/**
 * Progress values that release the work order back to the unassigned queue.
 * The caller must also clear `vendor_id` and fire `work-order/vendor_declined`
 * so the next-best vendor is suggested.
 */
export function releasesVendor(progress: VendorProgress): boolean {
  return progress === 'declined' || progress === 'cancelled_by_vendor'
}

/**
 * Progress values where the vendor is BLOCKED and only the PM can unblock them.
 *
 * These notify the PM immediately rather than only sitting in a dropdown. A
 * technician standing outside a property he cannot enter, or holding a repair
 * that exceeds the NTE, is not a status update: it is a request. Leaving it
 * silent would be the same failure this whole axis exists to remove.
 */
export function blocksOnPm(progress: VendorProgress): boolean {
  return progress === 'awaiting_access' || progress === 'hold_pm_approval'
}

/**
 * `job_completed` is NOT selectable from the progress dropdown.
 *
 * Completion is the outcome of submitting the completion form, which routes
 * through `finalizeWorkOrderCompletion()` and carries the
 * `work-order/completed` event, `completed_date`, the `work_order_updates` row
 * and the source-schedule advance with it. A dropdown that could write
 * `status: 'completed'` directly would be a second completion path that skips
 * every one of those, including the owner P&L expense. See
 * unit/guardrails/work-order-completion-side-effects.test.ts.
 */
export function isSelectableByVendor(progress: VendorProgress): boolean {
  return progress !== 'job_completed'
}

/**
 * Display order for the dropdown: the states a vendor actually picks while the
 * job is live, declining excluded (that is its own button on the accept screen,
 * not a step in a progression).
 */
export const VENDOR_PROGRESS_DROPDOWN: readonly VendorProgress[] =
  VENDOR_PROGRESS_VALUES.filter(
    (p) => isSelectableByVendor(p) && !releasesVendor(p),
  )

/** Customer-facing labels. No em dash, per the styling rule. */
const PROGRESS_LABELS: Record<VendorProgress, string> = {
  declined:               'Declined',
  cancelled_by_vendor:    'Cancelled by vendor',
  appointment_scheduled:  'Appointment scheduled',
  on_the_way:             'On the way',
  tech_on_site:           'Tech on site',
  awaiting_access:        'Waiting on access',
  hold_pm_approval:       'Waiting on your approval',
  parts_ordered:          'Parts ordered',
  repair_in_progress:     'Repair in progress',
  return_visit_scheduled: 'Return visit scheduled',
  job_completed:          'Job completed',
}

export function vendorProgressLabel(progress: VendorProgress): string {
  return PROGRESS_LABELS[progress]
}

const DECLINE_REASON_LABELS: Record<VendorDeclineReason, string> = {
  no_capacity:            'No capacity right now',
  outside_service_area:   'Outside my service area',
  not_my_trade:           'Not my trade',
  price_below_minimum:    'Below my minimum',
  cannot_access_property: 'Cannot access the property',
  other:                  'Other',
}

export function vendorDeclineReasonLabel(reason: VendorDeclineReason): string {
  return DECLINE_REASON_LABELS[reason]
}

export function isVendorProgress(value: unknown): value is VendorProgress {
  return typeof value === 'string'
    && (VENDOR_PROGRESS_VALUES as readonly string[]).includes(value)
}

export function isVendorDeclineReason(value: unknown): value is VendorDeclineReason {
  return typeof value === 'string'
    && (VENDOR_DECLINE_REASONS as readonly string[]).includes(value)
}
