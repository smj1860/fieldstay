import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'
import { parseLocalDate } from '@/lib/utils/date-validation'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import type { Enums } from '@/types/database'
import {
  createMaintenanceWorkOrder,
  computeVacancyGaps,
  type DueSoonScheduleRow,
  type DueSoonVendor,
  type GapBooking,
  type GapScheduleRow,
  type VendorPortalEvent,
} from './maintenance-schedules-helpers'

const ALERT_WINDOW_DAYS = 7   // alert PM when schedule due within 7 days

/**
 * Pass 1's row shape: DueSoonScheduleRow (what createMaintenanceWorkOrder
 * consumes) plus the seasonal-window / recurrence columns this file needs to
 * decide whether to act and how to roll next_due_date forward.
 */
interface DueScheduleRow extends DueSoonScheduleRow {
  schedule_type:     string | null
  frequency:         string | null
  active_from_month: number | null
  active_to_month:   number | null
  vendors:           DueSoonVendor | DueSoonVendor[] | null
}

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * Escalates an already-open work order for an overdue schedule to urgent, and
 * records the escalation note the daily wrap-up's escalation section reads.
 *
 * Extracted from the overdue pass because folding the idempotency guard inline
 * took that step past both the nesting-depth and cognitive-complexity limits —
 * and because the escalate-then-note pair is one unit: neither half is correct
 * without the other.
 */
async function escalateOverdueWorkOrder(
  supabase: ServiceClient,
  openWO:   { id: string; priority: string | null; status: Enums<'wo_status'> },
  schedule: { id: string; org_id: string },
  daysLate: number,
): Promise<void> {
  if (openWO.priority === 'urgent') return

  // `.neq('priority','urgent').select('id')` makes this an optimistic-locked
  // update that returns the rows it actually changed, which is what makes the
  // note insert idempotent — the same guard cron/work-order-ops.ts uses for
  // its bulk twin. A step retry finds the WO already urgent, matches zero
  // rows, and writes no second note.
  //
  // That duplicate note was a known, deliberately-open gap in
  // unit/guardrails/inngest-insert-idempotency.test.ts, left pending a
  // decision about what makes two escalation events "the same". The sibling
  // had already answered that, so this copies the answer rather than
  // re-litigating it.
  //
  // Both writes are bound and org-scoped. Unnoticed, a failed update left the
  // WO at its old priority while the note below claimed it had been
  // escalated — and the wrap-up builds its escalation section from those
  // notes, so the digest reported an escalation that never happened.
  const { data: escalatedRows, error: escalateError } = await supabase
    .from('work_orders')
    .update({ priority: 'urgent' })
    .eq('id', openWO.id)
    .eq('org_id', schedule.org_id)
    .neq('priority', 'urgent')
    .select('id')

  if (escalateError) {
    throw new Error(`overdue escalation failed for work order ${openWO.id}: ${escalateError.message}`)
  }

  // Zero rows = a concurrent run or an earlier attempt already escalated it.
  // Not an error, and specifically not a reason to write a duplicate note.
  if (!escalatedRows?.length) return

  const { error: noteError } = await supabase.from('work_order_updates').insert({
    work_order_id:             openWO.id,
    org_id:                    schedule.org_id,
    updated_via_vendor_portal: false,
    status_from:               openWO.status,
    status_to:                 openWO.status,
    notes:                     `Priority auto-escalated to Urgent — ${daysLate} day${daysLate !== 1 ? 's' : ''} past scheduled date`,
  })

  if (noteError) {
    throw new Error(`work_order_updates escalation note failed for ${openWO.id}: ${noteError.message}`)
  }

  await logAuditEvent({
    orgId:      schedule.org_id,
    action:     'work_order.updated',
    targetType: 'work_order',
    targetId:   openWO.id,
    metadata:   { change: 'auto_escalated_to_urgent', maintenance_schedule_id: schedule.id },
  })
}

/**
 * SCHEDULED: 13:00 UTC daily (8am CT).
 *
 * Cron stagger: asset-health runs at 12:30, this at 13:00, work-order-ops at
 * 13:30. All three previously fired at 13:00 and hit Supabase simultaneously.
 *
 * DISPATCHER ONLY. Every pass below used to run platform-wide inside this one
 * invocation: two serial `for (schedule of allSchedules) { await step.run() }`
 * loops (one step per schedule, unbounded step count), and a vacancy-gap pass
 * that pulled ALL active properties + ALL their bookings + ALL their schedules
 * into memory in a single step through three unbounded `.select()`s. Each of
 * those selects is silently capped at PostgREST's 1000-row limit, so the
 * truncation was simultaneously producing wrong results AND masking the step
 * explosion underneath.
 *
 * Now: one `org/maintenance_schedules.requested` per org, handled by
 * maintenanceSchedulesOrg under its own concurrency cap.
 */
export const dailyMaintenanceScheduleCheck = inngest.createFunction(
  {
    id:      'cron-maintenance-schedule-check',
    name:    'Cron: Maintenance Schedule Alerts',
    retries: 2,
  },
  { cron: '0 13 * * *' },  // 8am CT (UTC-5)
  async ({ step, logger }) => {
    const nowMs = await step.run('capture-now', async () => Date.now())

    const orgIds = await step.run('find-orgs-with-schedules-or-properties', async () => {
      const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })

      // Union of orgs with any active schedule (passes 1 & 2) and orgs with
      // any active property (pass 3's vacancy gaps, which is schedule-driven
      // but starts from properties).
      const [scheduleOrgs, propertyOrgs] = await Promise.all([
        fetchDistinctOrgIds(
          (from, to) => supabase
            .from('maintenance_schedules')
            .select('org_id')
            .eq('is_active', true)
            .order('org_id', { ascending: true })
            .range(from, to),
          { label: 'maintenance_schedules.org_id' }
        ),
        fetchDistinctOrgIds(
          (from, to) => supabase
            .from('properties')
            .select('org_id')
            .eq('is_active', true)
            .order('org_id', { ascending: true })
            .range(from, to),
          { label: 'properties.org_id' }
        ),
      ])

      return Array.from(new Set([...scheduleOrgs, ...propertyOrgs]))
    })

    logger.info(`Maintenance schedules: dispatching ${orgIds.length} org(s)`)

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-maintenance-schedules',
        orgIds.map((orgId) => ({
          name: 'org/maintenance_schedules.requested' as const,
          data: { org_id: orgId, now_ms: nowMs },
        }))
      )
    }

    // ── Thirty-day milestone ────────────────────────────────────────────────
    // Platform-level and already bounded to a 2-day creation window — stays in
    // the dispatcher rather than fanning out.
    await step.run('check-thirty-day-milestone', async () => {
      const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })
      const windowStart = new Date(nowMs - 32 * 86_400_000).toISOString()
      const windowEnd   = new Date(nowMs - 30 * 86_400_000).toISOString()
      const orgs = await fetchAllRows<{ id: string }>(
        (from, to) => supabase
          .from('organizations')
          .select('id')
          .gte('created_at', windowStart)
          .lte('created_at', windowEnd)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'organizations(thirty-day)' }
      )

      if (orgs.length) {
        await supabase.from('org_milestones').upsert(
          orgs.map(org => ({ org_id: org.id, milestone: 'thirty_days' })),
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
      }
    })

    return { dispatched: orgIds.length }
  }
)

/**
 * Per-org maintenance schedule processing. One invocation = one tenant.
 *
 * Pass 1 — due-soon: schedules due within ALERT_WINDOW_DAYS
 *   • auto_create_wo = true  → create WO
 *   • auto_create_wo = false → no-op (surfaced by cron-daily-wrapup instead)
 *
 * Pass 2 — overdue escalation: schedules past their due date
 *   • If an open WO exists for the schedule → bump priority to urgent
 *   • If no WO exists → create one (regardless of auto_create_wo)
 *
 * Pass 3 — vacancy-gap maintenance suggestions, scoped to this org.
 *
 * Step counts now scale with one tenant's schedule backlog rather than the
 * whole platform's, and a failing tenant retries only itself.
 */
export const maintenanceSchedulesOrg = inngest.createFunction(
  {
    id:          'maintenance-schedules-org',
    name:        'Maintenance Schedules — per org',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'org/maintenance_schedules.requested' },
  async ({ event, step, logger }) => {
    const orgId = event.data.org_id
    const today = new Date(event.data.now_ms)
    const todayStr = today.toISOString().split('T')[0]!

    const alertDate = new Date(today)
    alertDate.setDate(alertDate.getDate() + ALERT_WINDOW_DAYS)

    // ── Pass 1: Due-soon schedules ─────────────────────────────────────────
    const dueSchedules = await step.run('find-due-schedules', async () => {
      const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })
      return fetchAllRows<DueScheduleRow>(
        (from, to) => supabase
          .from('maintenance_schedules')
          .select(`
            id, name, schedule_type, frequency, estimated_cost,
            instructions, auto_create_wo, next_due_date,
            active_from_month, active_to_month,
            assigned_vendor_id, property_id, org_id,
            properties ( name, city, state ),
            vendors ( id, name, email, portal_enabled )
          `)
          .eq('org_id', orgId)
          .eq('is_active', true)
          .lte('next_due_date', alertDate.toISOString().split('T')[0]!)
          .gte('next_due_date', todayStr)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `maintenance_schedules(due)[org=${orgId}]` }
      )
    })

    // ── Pass 2 lookup: Overdue schedules ───────────────────────────────────
    const overdueSchedules = await step.run('find-overdue-schedules', async () => {
      const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })
      return fetchAllRows<{
        id: string; name: string; estimated_cost: number | null
        next_due_date: string | null; assigned_vendor_id: string | null
        property_id: string; org_id: string
      }>(
        (from, to) => supabase
          .from('maintenance_schedules')
          .select(`
            id, name, estimated_cost, next_due_date,
            assigned_vendor_id, property_id, org_id,
            properties ( name ),
            vendors ( name )
          `)
          .eq('org_id', orgId)
          .eq('is_active', true)
          .lt('next_due_date', todayStr)  // past due date
          .order('id', { ascending: true })
          .range(from, to),
        { label: `maintenance_schedules(overdue)[org=${orgId}]` }
      )
    })

    logger.info(
      `Org ${orgId}: ${dueSchedules.length} schedule(s) due within ${ALERT_WINDOW_DAYS} days, ` +
      `${overdueSchedules.length} overdue`
    )

    for (const schedule of dueSchedules) {
      const processResult = await step.run(`process-schedule-${schedule.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })
        const vendor   = unwrapJoin(schedule.vendors)

        let dueDate: Date
        try {
          dueDate = parseLocalDate(schedule.next_due_date, 'next_due_date')
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
          return
        }
        const daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / 86_400_000)

        // Skip items outside their seasonal window — no WO, no alert
        if (!isMaintenanceItemActiveThisMonth(schedule.active_from_month ?? null, schedule.active_to_month ?? null)) {
          return
        }

        // schedule.auto_create_wo === false path used to alert the PM here
        // that a schedule was coming up due soon — now covered by
        // cron-daily-wrapup's maintenance digest section instead.
        let vendorPortalEvent: VendorPortalEvent | null = null
        if (schedule.auto_create_wo) {
          vendorPortalEvent = await createMaintenanceWorkOrder(supabase, schedule, vendor ?? null, daysUntilDue)

          // Advance next_due_date for routine schedules — only once a WO was
          // actually created to track it. Reminder-only (auto_create_wo=false)
          // schedules must NOT roll forward here: nothing acted on them yet,
          // and cron-daily-wrapup's due-schedule section reads next_due_date
          // at 6pm — if this 8am pass had already advanced it past today,
          // the schedule would get no PM-facing surface at all.
          if (schedule.schedule_type === 'routine' && schedule.frequency) {
            const nextDue = calcNextDueDate(schedule.frequency, dueDate)
            // Bound and org-scoped, matching advanceScheduleNextDueDate in
            // app/(dashboard)/maintenance/actions.ts. This is the third copy of
            // the same advance and the second that was silent.
            //
            // The WO has already been created by the line above, so a failed
            // advance leaves next_due_date pointing at a date that is now
            // handled: tomorrow the schedule looks due again, the
            // (source_schedule_id, scheduled_date) unique constraint rejects
            // the duplicate, and the schedule stops producing work orders for
            // this occurrence and every future one — silently, forever.
            //
            // Zero rows is expected: `.eq('next_due_date', ...)` is an
            // optimistic lock against workOrderOpsOrg advancing it first.
            const { error: advanceError } = await supabase
              .from('maintenance_schedules')
              .update({ next_due_date: nextDue.toISOString().split('T')[0] })
              .eq('id', schedule.id)
              .eq('org_id', schedule.org_id)
              .eq('next_due_date', schedule.next_due_date!)  // optimistic lock — prevents double-advance on retry

            if (advanceError) {
              throw new Error(
                `maintenance_schedules next_due_date advance failed for schedule ${schedule.id}: ${advanceError.message}`
              )
            }
          }
        }

        return { vendorPortalEvent }
      })

      if (processResult?.vendorPortalEvent) {
        await step.sendEvent(`fire-vendor-portal-${schedule.id}`, {
          name: 'work-order/created' as const,
          data: processResult.vendorPortalEvent,
        })
      }
    }

    // ── Pass 2: Overdue escalation ─────────────────────────────────────────
    for (const schedule of overdueSchedules) {
      await step.run(`escalate-overdue-${schedule.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })
        let dueDate: Date
        try {
          dueDate = parseLocalDate(schedule.next_due_date, 'next_due_date')
        } catch (err) {
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
          return
        }
        const daysLate = Math.round((today.getTime() - dueDate.getTime()) / 86_400_000)

        // Look for an open WO tied to this schedule
        // This read decides the whole branch, so its failure is not cosmetic.
        // Discarded, an error made openWO null, which sent an overdue schedule
        // that ALREADY has an open work order down the create path instead —
        // where the unique constraint no-ops the insert. Net effect: the
        // existing work order never gets escalated to urgent, which is the
        // entire purpose of this pass, and the run reports success.
        const openWORes = await supabase
          .from('work_orders')
          .select('id, priority, status')
          .eq('org_id', orgId)
          .eq('source_schedule_id', schedule.id)
          .not('status', 'in', '("completed","cancelled")')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (openWORes.error) {
          throw new Error(
            `overdue-pass open-WO lookup failed for schedule ${schedule.id}: ${openWORes.error.message}`
          )
        }
        const openWO = openWORes.data

        // The PM-facing escalation alerts that used to fire here are now
        // covered by cron-daily-wrapup's maintenance digest section instead.
        if (openWO) {
          await escalateOverdueWorkOrder(supabase, openWO, schedule, daysLate)
        } else {
          // No open WO — create one with urgent priority
          // Idempotency: skip insert if a WO already exists for this schedule + due date
          const existingWORes = await supabase
            .from('work_orders')
            .select('id')
            .eq('org_id', orgId)
            .eq('source_schedule_id', schedule.id)
            .eq('scheduled_date', schedule.next_due_date!)
            .eq('source', 'maintenance_schedule')
            .maybeSingle()

          if (existingWORes.error) {
            throw new Error(
              `overdue-pass idempotency check failed for schedule ${schedule.id}: ${existingWORes.error.message}`
            )
          }
          const existingWO = existingWORes.data

          const insertRes = existingWO
            ? { data: existingWO, error: null }
            : await supabase
                .from('work_orders')
                .insert({
                  property_id:        schedule.property_id,
                  org_id:             schedule.org_id,
                  vendor_id:          schedule.assigned_vendor_id ?? null,
                  title:              schedule.name,
                  description:        `OVERDUE ${daysLate} day${daysLate !== 1 ? 's' : ''}. Original due date: ${dueDate.toLocaleDateString()}`,
                  priority:           'urgent',
                  status:             'pending',
                  source:             'maintenance_schedule',
                  source_schedule_id: schedule.id,
                  scheduled_date:     schedule.next_due_date,
                  estimated_cost:     schedule.estimated_cost,
                  portal_enabled:     false,
                })
                .select('id')
                .single()

          // The insert's error was discarded entirely, so EVERY cause looked
          // the same as success-with-no-row: a lost race (23505 on the
          // (source_schedule_id, scheduled_date) unique index, which is
          // expected and benign) was indistinguishable from a constraint
          // violation, an RLS refusal or a dropped connection. The overdue
          // work order simply never existed and the pass reported a clean run.
          if (insertRes.error && insertRes.error.code !== '23505') {
            throw new Error(
              `overdue work order insert failed for schedule ${schedule.id}: ${insertRes.error.message}`
            )
          }
          const wo = insertRes.data

          if (wo && !existingWO) {
            await logAuditEvent({
              orgId:      schedule.org_id,
              action:     'work_order.created',
              targetType: 'work_order',
              targetId:   wo.id,
              metadata:   { source: 'maintenance_schedule_overdue', maintenance_schedule_id: schedule.id },
            })
          }
        }
      })
    }

    // ── Pass 3: Vacancy-gap maintenance suggestions (this org only) ─────────
    const gapSuggestions = await step.run('find-vacancy-gaps', async () => {
      const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })

      const properties = await fetchAllRows<{ id: string; org_id: string; name: string }>(
        (from, to) => supabase
          .from('properties')
          .select('id, org_id, name')
          .eq('org_id', orgId)
          .eq('is_active', true)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `properties[org=${orgId}]` }
      )

      if (!properties.length) return []

      const propertyIds = properties.map((p) => p.id)

      // ONE batch bookings query for all of this org's properties.
      const allBookings = await fetchAllRows<{
        property_id: string; checkin_date: string; checkout_date: string
      }>(
        (from, to) => supabase
          .from('bookings')
          .select('property_id, checkin_date, checkout_date')
          .eq('org_id', orgId)
          .in('property_id', propertyIds)
          .in('status', ['confirmed', 'tentative'])
          .gte('checkout_date', todayStr)
          .order('property_id',  { ascending: true })
          .order('checkin_date', { ascending: true })
          .range(from, to),
        { label: `bookings(vacancy-gaps)[org=${orgId}]` }
      )

      const bookingsByProperty = new Map<string, GapBooking[]>()
      for (const booking of allBookings) {
        const existing = bookingsByProperty.get(booking.property_id) ?? []
        existing.push({ checkin_date: booking.checkin_date, checkout_date: booking.checkout_date })
        bookingsByProperty.set(booking.property_id, existing)
      }

      // ONE batch maintenance_schedules query for all of this org's properties.
      const allSchedules = await fetchAllRows<GapScheduleRow>(
        (from, to) => supabase
          .from('maintenance_schedules')
          .select('id, property_id, name, next_due_date, estimated_cost, assigned_vendor_id, active_from_month, active_to_month')
          .eq('org_id', orgId)
          .in('property_id', propertyIds)
          .eq('is_active', true)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `maintenance_schedules(vacancy-gaps)[org=${orgId}]` }
      )

      const schedulesByProperty = new Map<string, GapScheduleRow[]>()
      for (const schedule of allSchedules) {
        const existing = schedulesByProperty.get(schedule.property_id) ?? []
        existing.push(schedule)
        schedulesByProperty.set(schedule.property_id, existing)
      }

      // Compute gaps + candidates entirely in memory — zero DB round trips.
      return computeVacancyGaps(properties, bookingsByProperty, schedulesByProperty)
    })

    // gapSuggestions used to be emailed to the PM — superseded by
    // cron-daily-wrapup's Monday-only vacancy section.

    return {
      org_id:         orgId,
      checked:        dueSchedules.length,
      escalated:      overdueSchedules.length,
      gapSuggestions: gapSuggestions.length,
    }
  }
)
