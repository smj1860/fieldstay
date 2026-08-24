import { unwrap } from '@/lib/supabase/unwrap'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'
import { deriveVacancyGaps } from '@/lib/maintenance/gaps'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { parseLocalDate } from '@/lib/utils/date-validation'
import { reportError } from '@/lib/observability/report-error'
import { createPmNotification } from '@/lib/inngest/helpers'
import type { Enums } from '@/types/database'

/**
 * Helpers for dailyMaintenanceScheduleCheck's Pass 1 (due-soon schedules)
 * and Pass 3 (vacancy-gap suggestions) — extracted out of
 * lib/inngest/functions/cron/maintenance-schedules.ts.
 */

export interface DueSoonScheduleRow {
  id:                 string
  name:               string
  instructions:        string | null
  auto_create_wo:      boolean
  next_due_date:       string | null
  assigned_vendor_id:  string | null
  property_id:         string
  org_id:              string
  estimated_cost:      number | null
}

export interface DueSoonVendor {
  id:             string
  name:           string
  email:          string | null
  portal_enabled: boolean
}

export type VendorPortalEvent = {
  work_order_id: string
  property_id:   string
  org_id:        string
  vendor_id:     string
  portal_enabled: true
}

/** A due inspection schedule, as the notify path needs it. */
export interface DueInspectionScheduleRow extends DueSoonScheduleRow {
  inspection_form_id:  string | null
  assigned_to_user_id: string | null
}

/**
 * A scheduled inspection has come due: tell someone, and create nothing.
 *
 * §7's asymmetry with the work-order path, and it is forced by
 * `inspections.started_at`, which is NOT NULL DEFAULT now(). A row minted here
 * would claim the walk began at 08:00 UTC on the cron's schedule, and §12.3's
 * report presents that duration as evidence of how the property was assessed.
 * It would also push a walk nobody has started onto every tablet, because the
 * warm pass caches inspections that are OPEN and a row is open from the moment
 * it exists.
 *
 * So the row is created when someone actually begins — the path that already
 * exists and already stamps a real start time — and this only surfaces that it
 * is time. The schedule advances on COMPLETION rather than here, which is the
 * same rule `auto_create_wo = false` reminder schedules already follow: nothing
 * has acted on it yet, so rolling it forward would hide it.
 *
 * DEDUPED PER OCCURRENCE, not per day. This cron looks 7 days ahead and runs
 * daily, so an undeduped notification would ring the bell seven times for one
 * quarterly walk. The key carries the due date, so the NEXT occurrence rings
 * again.
 */
export async function notifyInspectionDue(
  supabase:     SupabaseClient,
  schedule:     DueInspectionScheduleRow,
  daysUntilDue: number,
): Promise<void> {
  const when = daysUntilDue <= 0
    ? 'is due today'
    : `is due in ${pluralDays(daysUntilDue)}`

  await createPmNotification(supabase, {
    orgId:    schedule.org_id,
    type:     'inspection.scheduled_due',
    title:    `${schedule.name} ${when}`,
    subtitle: 'Open the property to start the walk.',
    href:     `/maintenance/inspections?property=${schedule.property_id}`,
    severity: daysUntilDue <= 0 ? 'amber' : 'blue',
    dedupeKey: `inspection-due:${schedule.id}:${schedule.next_due_date}`,
  })
}

/**
 * schedule.auto_create_wo === true path: create the WO (idempotent on
 * schedule + due date), audit log, and return the vendor portal-dispatch
 * event to fire (or null when nothing new was created). The PM-facing
 * "work order created" alert that used to fire here is now covered by
 * cron-daily-wrapup's maintenance digest section instead.
 */
export async function createMaintenanceWorkOrder(
  supabase:     SupabaseClient,
  schedule:     DueSoonScheduleRow,
  vendor:       DueSoonVendor | null,
  daysUntilDue: number,
): Promise<VendorPortalEvent | null> {
  // Idempotency: skip insert if a WO already exists for this schedule + due date
  // Fail CLOSED: discarding this error left existingWO null, which reads as
  // "no WO yet for this schedule+date" and falls through to creating one —
  // producing exactly the duplicate this check exists to prevent.
  const existingWORes = await supabase
    .from('work_orders')
    .select('id')
    .eq('source_schedule_id', schedule.id)
    .eq('scheduled_date', schedule.next_due_date!)
    .eq('source', 'maintenance_schedule')
    .maybeSingle()

  const existingWO = unwrap(existingWORes, {
    site:  'inngest.maintenance-schedules.existingWO',
    orgId: schedule.org_id,
  })

  let wo = existingWO
  if (!existingWO) {
    const { data: inserted, error } = await supabase
      .from('work_orders')
      .insert({
        property_id:        schedule.property_id,
        org_id:             schedule.org_id,
        vendor_id:          schedule.assigned_vendor_id ?? null,
        title:              schedule.name,
        description:        schedule.instructions,
        priority:           daysUntilDue <= 1 ? 'urgent' : daysUntilDue <= 3 ? 'high' : 'medium',
        status:             'pending',
        source:             'maintenance_schedule',
        source_schedule_id: schedule.id,
        scheduled_date:     schedule.next_due_date,
        estimated_cost:     schedule.estimated_cost,
        portal_enabled:     vendor?.portal_enabled ?? false,
      })
      .select('id')
      .single()

    if (error) {
      // 23505 = unique_violation on wo_maintenance_schedule_date_unique
      // (source_schedule_id, scheduled_date) WHERE source='maintenance_schedule' —
      // dailyWorkOrderOps's own auto-WO pass (7.4) races this same schedule+date
      // at the same 8am CT cron time. The DB constraint is the real guard against
      // a duplicate WO; losing this race is expected, not an error — any other
      // error code is real and should retry the step.
      if (error.code !== '23505') throw new Error(`Failed to insert maintenance WO: ${error.message}`)
      wo = null
    } else {
      wo = inserted
    }
  }

  if (wo && !existingWO) {
    await logAuditEvent({
      orgId:      schedule.org_id,
      action:     'work_order.created',
      targetType: 'work_order',
      targetId:   wo.id,
      metadata:   { source: 'maintenance_schedule', maintenance_schedule_id: schedule.id },
    })
  }

  return (wo && vendor?.email && vendor?.portal_enabled && !existingWO)
    ? {
        work_order_id:  wo.id,
        property_id:    schedule.property_id,
        org_id:         schedule.org_id,
        vendor_id:      vendor.id,
        portal_enabled: true as const,
      }
    : null
}

// ── Pass 2: overdue escalation, batched ──────────────────────────────────────
//
// This pass used to be `for (const schedule of overdueSchedules) { await
// step.run(...) }` — one Inngest step and two `work_orders` round-trips per
// overdue schedule, every day.
//
// The set it iterates does not self-clear. A schedule leaves it only when
// something advances next_due_date past today, and for a schedule that is
// already overdue nothing does: this pass creates a work order but never
// advances, and workOrderOpsOrg's auto-WO pass returns early the moment its
// pre-check finds that work order, before its own advance. Completion is the
// only exit, and advanceSchedulesAfterCompletion advances routine schedules
// only — a seasonal or one-time schedule records last_completed_date and stays
// overdue permanently. So the loop was O(every schedule the org has ever let
// slip), growing monotonically, re-paid in full every single day.
//
// Batched: two reads, one bulk UPDATE, and one bulk INSERT per BATCH_SIZE
// schedules instead of per schedule. Mirrors the already-batched aging
// escalation in cron/work-order-ops.ts (7.1), which is the same escalate-then-
// note pair against the same table.

const OVERDUE_BATCH_SIZE = 100

/** RETURNING is a PostgREST response like any other — max_rows truncates it. */
const UPDATE_RETURNING_CHUNK = 500

/** How many times to re-read and retry a bulk insert that lost a create race. */
const CREATE_RACE_ATTEMPTS = 3

export interface OverdueScheduleRow {
  id:                 string
  name:               string
  estimated_cost:     number | null
  next_due_date:      string | null
  assigned_vendor_id: string | null
  property_id:        string
  org_id:             string
}

interface OpenWorkOrder {
  id:                 string
  priority:           string | null
  status:             Enums<'wo_status'>
  source_schedule_id: string
}

export interface OverdueBatchResult {
  escalated: number
  created:   number
  skipped:   number
}

export function dueKey(scheduleId: string, dueDate: string): string {
  return `${scheduleId}|${dueDate}`
}

function pluralDays(n: number): string {
  return `${n} day${n !== 1 ? 's' : ''}`
}

/**
 * The newest still-open work order per schedule, for a whole batch in one read.
 *
 * Replaces the per-schedule `.limit(1).maybeSingle()` lookup. Ordering by
 * created_at descending and keeping the FIRST row seen per schedule reproduces
 * that `.limit(1)` exactly.
 */
async function loadOpenWorkOrders(
  supabase:    SupabaseClient,
  orgId:       string,
  scheduleIds: string[],
): Promise<Map<string, OpenWorkOrder>> {
  const rows = await fetchAllRows<OpenWorkOrder>(
    (from, to) => supabase
      .from('work_orders')
      .select('id, priority, status, source_schedule_id')
      .eq('org_id', orgId)
      .in('source_schedule_id', scheduleIds)
      .not('status', 'in', '("completed","cancelled")')
      .order('created_at', { ascending: false })
      .order('id',         { ascending: false })
      .range(from, to),
    { label: 'work_orders(overdue-open)' },
  )

  const newestPerSchedule = new Map<string, OpenWorkOrder>()
  for (const row of rows) {
    if (!newestPerSchedule.has(row.source_schedule_id)) newestPerSchedule.set(row.source_schedule_id, row)
  }
  return newestPerSchedule
}

/**
 * Which (schedule, due date) pairs already have a work order — open, completed
 * or cancelled. One read for the whole set, replacing a per-schedule
 * idempotency pre-check.
 *
 * "Any work order at that date" is the right question rather than "any OPEN
 * one": wo_maintenance_schedule_date_unique does not care about status, so a
 * completed work order at that date makes the insert a guaranteed 23505 too.
 * Exported because cron/work-order-ops.ts's auto-WO pass needs exactly this
 * question answered for its own schedule set.
 */
export async function loadExistingDueDatePairs(
  supabase:  SupabaseClient,
  orgId:     string,
  schedules: { id: string; next_due_date: string | null }[],
): Promise<Set<string>> {
  if (!schedules.length) return new Set()

  const rows = await fetchAllRows<{ source_schedule_id: string; scheduled_date: string }>(
    (from, to) => supabase
      .from('work_orders')
      .select('source_schedule_id, scheduled_date')
      .eq('org_id', orgId)
      .eq('source', 'maintenance_schedule')
      .in('source_schedule_id', schedules.map((s) => s.id))
      .in('scheduled_date',     Array.from(new Set(schedules.map((s) => s.next_due_date!))))
      .order('id', { ascending: true })
      .range(from, to),
    { label: 'work_orders(overdue-existing)' },
  )

  return new Set(rows.map((r) => dueKey(r.source_schedule_id, r.scheduled_date)))
}

/**
 * Bulk-escalate to urgent and write one note per work order that actually
 * changed.
 *
 * `.neq('priority','urgent').select('id')` is the same optimistic lock the
 * per-schedule version used: a step retry matches zero rows and writes no
 * second note. Chunked because the RETURNING clause truncates at max_rows —
 * without that, a >1000 backlog escalated correctly but under-reported, and
 * the daily wrap-up builds its escalation section from these notes.
 */
async function escalateOpenWorkOrders(
  supabase: SupabaseClient,
  orgId:    string,
  targets:  { wo: OpenWorkOrder; schedule: OverdueScheduleRow; daysLate: number }[],
): Promise<number> {
  if (!targets.length) return 0

  const changedIds = new Set<string>()
  for (let i = 0; i < targets.length; i += UPDATE_RETURNING_CHUNK) {
    const chunk = targets.slice(i, i + UPDATE_RETURNING_CHUNK)
    const { data: changedRows, error } = await supabase
      .from('work_orders')
      .update({ priority: 'urgent' })
      .eq('org_id', orgId)
      .in('id', chunk.map((t) => t.wo.id))
      .neq('priority', 'urgent')
      .select('id')

    if (error) throw new Error(`overdue escalation failed: ${error.message}`)
    for (const row of changedRows ?? []) changedIds.add(row.id)
  }

  const changed = targets.filter((t) => changedIds.has(t.wo.id))
  if (!changed.length) return 0

  const { error: noteError } = await supabase.from('work_order_updates').insert(
    changed.map(({ wo, daysLate }) => ({
      work_order_id:             wo.id,
      org_id:                    orgId,
      updated_via_vendor_portal: false,
      status_from:               wo.status,
      status_to:                 wo.status,
      notes:                     `Priority auto-escalated to Urgent — ${pluralDays(daysLate)} past scheduled date`,
    }))
  )
  if (noteError) throw new Error(`work_order_updates escalation notes failed: ${noteError.message}`)

  await logAuditEvents(
    changed.map(({ wo, schedule }) => ({
      orgId,
      action:     'work_order.updated' as const,
      targetType: 'work_order',
      targetId:   wo.id,
      metadata:   { change: 'auto_escalated_to_urgent', maintenance_schedule_id: schedule.id },
    }))
  )

  return changed.length
}

function overdueWorkOrderRow(schedule: OverdueScheduleRow, daysLate: number, dueDate: Date) {
  return {
    property_id:        schedule.property_id,
    org_id:             schedule.org_id,
    vendor_id:          schedule.assigned_vendor_id ?? null,
    title:              schedule.name,
    description:        `OVERDUE ${pluralDays(daysLate)}. Original due date: ${dueDate.toLocaleDateString()}`,
    priority:           'urgent' as const,
    status:             'pending' as const,
    source:             'maintenance_schedule' as const,
    source_schedule_id: schedule.id,
    scheduled_date:     schedule.next_due_date,
    estimated_cost:     schedule.estimated_cost,
    portal_enabled:     false,
  }
}

/**
 * Create the missing overdue work orders for a batch in one INSERT.
 *
 * A bulk insert here CANNOT use ON CONFLICT: wo_maintenance_schedule_date_unique
 * is a PARTIAL unique index (`WHERE source = 'maintenance_schedule' AND
 * source_schedule_id IS NOT NULL`) and PostgREST cannot emit an index
 * predicate, so Postgres rejects the bare `ON CONFLICT (source_schedule_id,
 * scheduled_date)` with 42P10 — verified against the live schema, where the
 * predicated form is accepted and the bare one is not. One collision therefore
 * aborts the WHOLE statement and would take every other row in the batch with
 * it, which is why losing the race is handled by re-reading and retrying with
 * the survivors rather than by swallowing a 23505.
 *
 * The race is real but narrow: workOrderOpsOrg's auto-WO pass writes the same
 * (schedule, date) pair, 30 minutes later on the cron clock.
 */
async function createMissingOverdueWorkOrders(
  supabase:   SupabaseClient,
  orgId:      string,
  candidates: { schedule: OverdueScheduleRow; daysLate: number; dueDate: Date }[],
): Promise<number> {
  if (!candidates.length) return 0

  for (let attempt = 1; attempt <= CREATE_RACE_ATTEMPTS; attempt++) {
    const existing = await loadExistingDueDatePairs(supabase, orgId, candidates.map((c) => c.schedule))
    const missing  = candidates.filter((c) => !existing.has(dueKey(c.schedule.id, c.schedule.next_due_date!)))
    if (!missing.length) return 0

    const { data: inserted, error } = await supabase
      .from('work_orders')
      .insert(missing.map((c) => overdueWorkOrderRow(c.schedule, c.daysLate, c.dueDate)))
      .select('id, source_schedule_id')

    if (!error) {
      await logAuditEvents(
        (inserted ?? []).map((wo: { id: string; source_schedule_id: string }) => ({
          orgId,
          action:     'work_order.created' as const,
          targetType: 'work_order',
          targetId:   wo.id,
          metadata:   { source: 'maintenance_schedule_overdue', maintenance_schedule_id: wo.source_schedule_id },
        }))
      )
      return inserted?.length ?? 0
    }

    if (error.code !== '23505') throw new Error(`overdue work order insert failed: ${error.message}`)
  }

  throw new Error(
    `overdue work order insert lost the create race ${CREATE_RACE_ATTEMPTS} times for org ${orgId} — ` +
    `retrying the step rather than dropping the batch`
  )
}

/**
 * One batch of overdue schedules: escalate the ones that already have an open
 * work order, create one for the ones that do not.
 *
 * Every write is idempotent against a step retry — the escalation is
 * optimistic-locked on `.neq('priority','urgent')` and the create is guarded by
 * a re-read of the existing (schedule, date) pairs — which is what makes a
 * batch safe to retry as a unit. A batch that partially succeeded and then
 * retries re-does no work and writes no duplicate note.
 */
export async function processOverdueBatch(
  supabase: SupabaseClient,
  orgId:    string,
  batch:    OverdueScheduleRow[],
  today:    Date,
): Promise<OverdueBatchResult> {
  const dated: { schedule: OverdueScheduleRow; dueDate: Date; daysLate: number }[] = []
  let skipped = 0

  for (const schedule of batch) {
    try {
      const dueDate = parseLocalDate(schedule.next_due_date, 'next_due_date')
      dated.push({
        schedule,
        dueDate,
        daysLate: Math.round((today.getTime() - dueDate.getTime()) / 86_400_000),
      })
    } catch (err) {
      skipped++
      console.error(`[maintenance-cron] invalid next_due_date in overdue pass for schedule ${schedule.id}`, {
        schedule_id:   schedule.id,
        next_due_date: schedule.next_due_date,
        error:         String(err),
      })
      reportError(err, {
        site:  'inngest.maintenance-cron.invalid_due_date_overdue',
        orgId: schedule.org_id,
        extra: { schedule_id: schedule.id },
      })
    }
  }

  if (!dated.length) return { escalated: 0, created: 0, skipped }

  const openBySchedule = await loadOpenWorkOrders(supabase, orgId, dated.map((d) => d.schedule.id))

  const toEscalate = dated
    .map((d) => ({ ...d, wo: openBySchedule.get(d.schedule.id) }))
    .filter((d): d is typeof d & { wo: OpenWorkOrder } => d.wo !== undefined && d.wo.priority !== 'urgent')
  const toCreate = dated.filter((d) => !openBySchedule.has(d.schedule.id))

  const escalated = await escalateOpenWorkOrders(supabase, orgId, toEscalate)
  const created   = await createMissingOverdueWorkOrders(supabase, orgId, toCreate)

  return { escalated, created, skipped }
}

export function chunkOverdueSchedules(schedules: OverdueScheduleRow[]): OverdueScheduleRow[][] {
  const batches: OverdueScheduleRow[][] = []
  for (let i = 0; i < schedules.length; i += OVERDUE_BATCH_SIZE) {
    batches.push(schedules.slice(i, i + OVERDUE_BATCH_SIZE))
  }
  return batches
}

export const OVERDUE_BATCHING = { OVERDUE_BATCH_SIZE, UPDATE_RETURNING_CHUNK, CREATE_RACE_ATTEMPTS } as const

// ── Pass 1: which due-soon schedules are actually actionable ─────────────────

/** The subset of DueSoonScheduleRow this filter needs to make its decision. */
export interface ActionableCandidate extends DueSoonScheduleRow {
  active_from_month: number | null
  active_to_month:   number | null
}

/**
 * Narrow a due-soon set to the schedules that will actually do something, so
 * the caller spends an Inngest step per unit of WORK rather than per row it
 * looked at.
 *
 * Three of the four outcomes of the old per-schedule step were no-ops that
 * still cost a full step and a state round-trip: a reminder-only schedule
 * (auto_create_wo = false, whose PM-facing surface is cron-daily-wrapup, not
 * this pass), a schedule outside its seasonal window, and a schedule with an
 * unparseable due date. Reminder-only is not a rare shape — the existing
 * >1000-row test in this cron's suite seeds 2,100 of them for one org, which
 * was 2,100 sequential steps producing nothing.
 *
 * Invalid dates are reported here rather than skipped silently, exactly as the
 * per-schedule body did. Run this INSIDE a step.run so the report fires once
 * per invocation rather than on every function replay.
 */
export function selectActionableDueSchedules<T extends ActionableCandidate>(
  schedules: T[],
  today:     Date,
): { schedule: T; daysUntilDue: number }[] {
  const actionable: { schedule: T; daysUntilDue: number }[] = []

  for (const schedule of schedules) {
    if (!schedule.auto_create_wo) continue
    if (!isMaintenanceItemActiveThisMonth(schedule.active_from_month, schedule.active_to_month)) continue

    try {
      const dueDate = parseLocalDate(schedule.next_due_date, 'next_due_date')
      actionable.push({
        schedule,
        daysUntilDue: Math.round((dueDate.getTime() - today.getTime()) / 86_400_000),
      })
    } catch (err) {
      console.error(`[maintenance-cron] invalid next_due_date on schedule ${schedule.id}`, {
        schedule_id:   schedule.id,
        next_due_date: schedule.next_due_date,
        error:         String(err),
      })
      reportError(err, {
        site:  'inngest.maintenance-cron.invalid_due_date',
        orgId: schedule.org_id,
        extra: { schedule_id: schedule.id },
      })
    }
  }

  return actionable
}

// ── Vacancy-gap suggestions (Pass 3) ─────────────────────────────────────────

const STRONG_GAP_DAYS = 30
const LIGHT_GAP_DAYS  = 14
const LOOKAHEAD_DAYS  = 90

export interface GapProperty {
  id:     string
  org_id: string
  name:   string
}

export interface GapBooking {
  checkin_date:  string
  checkout_date: string
}

export interface GapScheduleRow {
  id:                 string
  property_id:        string
  name:               string
  next_due_date:      string | null
  estimated_cost:     number | null
  assigned_vendor_id: string | null
  active_from_month:  number | null
  active_to_month:    number | null
}

export interface GapSuggestion {
  property_id:   string
  org_id:        string
  property_name: string
  gap_start:     string
  gap_end:       string | null
  gap_days:      number
  tier:          'strong' | 'light'
  candidates: Array<{
    id: string; name: string; next_due_date: string
    estimated_cost: number | null; assigned_vendor_id: string | null
  }>
}

/**
 * Pure in-memory computation of vacancy-gap maintenance suggestions —
 * every property's bookings and schedules are already batch-fetched by the
 * caller, so this does zero DB round trips.
 *
 * The gap derivation itself moved to `lib/maintenance/gaps.ts` when the
 * inspection scheduler needed the inverse question answered (given a month,
 * find a free day in it). Two derivations would be two definitions of "free",
 * and only one of them could be right. `horizonStart` is deliberately not
 * passed: these suggestions are about a window that opens when a guest leaves,
 * so the period before the FIRST booking is not one of them.
 */
export function computeVacancyGaps(
  properties:          GapProperty[],
  bookingsByProperty:  Map<string, GapBooking[]>,
  schedulesByProperty: Map<string, GapScheduleRow[]>,
): GapSuggestion[] {
  const results: GapSuggestion[] = []

  for (const property of properties) {
    const bookings  = bookingsByProperty.get(property.id) ?? []
    if (!bookings.length) continue
    const schedules = schedulesByProperty.get(property.id) ?? []

    for (const gap of deriveVacancyGaps(bookings, LOOKAHEAD_DAYS)) {
      if (gap.days < LIGHT_GAP_DAYS) continue

      // next_due_date <= min(windowEnd, windowStart + LOOKAHEAD_DAYS), and
      // only schedules whose seasonal window is active this month.
      const capMs          = new Date(gap.start).getTime() + LOOKAHEAD_DAYS * 86_400_000
      const effectiveEndMs = gap.end
        ? Math.min(new Date(gap.end).getTime(), capMs)
        : capMs
      const effectiveEnd   = new Date(effectiveEndMs).toISOString().split('T')[0]!

      const eligible = schedules
        .filter((s) =>
          s.next_due_date !== null &&
          s.next_due_date <= effectiveEnd &&
          isMaintenanceItemActiveThisMonth(s.active_from_month ?? null, s.active_to_month ?? null)
        )
        .map((s) => ({
          id:                 s.id,
          name:               s.name,
          next_due_date:      s.next_due_date!,
          estimated_cost:     s.estimated_cost,
          assigned_vendor_id: s.assigned_vendor_id,
        }))

      if (!eligible.length) continue

      results.push({
        property_id:   property.id,
        org_id:        property.org_id,
        property_name: property.name,
        gap_start:     gap.start,
        gap_end:       gap.end,
        gap_days:      gap.days,
        tier:          gap.days >= STRONG_GAP_DAYS ? 'strong' : 'light',
        candidates:    eligible,
      })
    }
  }

  return results
}
