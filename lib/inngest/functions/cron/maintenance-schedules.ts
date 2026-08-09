import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { parseLocalDate } from '@/lib/utils/date-validation'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { unwrap } from '@/lib/supabase/unwrap'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import {
  createMaintenanceWorkOrder,
  computeVacancyGaps,
  chunkOverdueSchedules,
  processOverdueBatch,
  selectActionableDueSchedules,
  type DueSoonScheduleRow,
  type DueSoonVendor,
  type GapBooking,
  type GapScheduleRow,
  type OverdueScheduleRow,
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
        const res = await supabase.from('org_milestones').upsert(
          orgs.map(org => ({ org_id: org.id, milestone: 'thirty_days' })),
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
        unwrap(res, { site: 'inngest.maintenance-schedules.check-thirty-day-milestone' })
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
      return fetchAllRows<OverdueScheduleRow>(
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

    // One step per unit of WORK, not per row looked at: reminder-only
    // schedules, seasonally-inactive ones and unparseable dates all used to
    // burn a full step apiece to reach a `return`. Inside a step so the
    // invalid-date reports fire once per invocation, not on every replay.
    const actionable = await step.run('select-actionable-due-schedules', async () =>
      selectActionableDueSchedules(dueSchedules, today))

    for (const { schedule, daysUntilDue } of actionable) {
      const processResult = await step.run(`process-schedule-${schedule.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })
        const vendor   = unwrapJoin(schedule.vendors)
        const dueDate  = parseLocalDate(schedule.next_due_date, 'next_due_date')

        // schedule.auto_create_wo === false never reaches here — that path's
        // PM-facing surface is cron-daily-wrapup's maintenance digest section.
        const vendorPortalEvent: VendorPortalEvent | null =
          await createMaintenanceWorkOrder(supabase, schedule, vendor ?? null, daysUntilDue)

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

        return { vendorPortalEvent }
      })

      if (processResult?.vendorPortalEvent) {
        await step.sendEvent(`fire-vendor-portal-${schedule.id}`, {
          name: 'work-order/created' as const,
          data: processResult.vendorPortalEvent,
        })
      }
    }

    // ── Pass 2: Overdue escalation (batched) ───────────────────────────────
    //
    // The PM-facing escalation alerts that used to fire here are now covered
    // by cron-daily-wrapup's maintenance digest section instead.
    const overdueBatches = chunkOverdueSchedules(overdueSchedules)
    for (let i = 0; i < overdueBatches.length; i++) {
      await step.run(`escalate-overdue-batch-${i}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:maintenance-schedules' })
        return processOverdueBatch(supabase, orgId, overdueBatches[i]!, today)
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
