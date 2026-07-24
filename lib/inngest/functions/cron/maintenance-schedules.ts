import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'
import { parseLocalDate } from '@/lib/utils/date-validation'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import {
  createMaintenanceWorkOrder,
  computeVacancyGaps,
  type GapBooking,
  type GapScheduleRow,
  type VendorPortalEvent,
} from './maintenance-schedules-helpers'

const ALERT_WINDOW_DAYS  = 7   // alert PM when schedule due within 7 days
const ESCALATE_DAYS_PAST = 3   // escalate when schedule is 3+ days overdue

/**
 * SCHEDULED: runs every morning at 8am CT.
 *
 * Pass 1 — due-soon: schedules due within ALERT_WINDOW_DAYS
 *   • auto_create_wo = true  → create WO
 *   • auto_create_wo = false → no-op (surfaced by cron-daily-wrapup instead)
 *
 * Pass 2 — overdue escalation: schedules past their due date
 *   • If an open WO exists for the schedule → bump priority to urgent
 *   • If no WO exists → create one (regardless of auto_create_wo)
 *
 * Also handles the thirty-day org milestone check.
 *
 * The PM-facing alert emails that used to fire from every pass here (due
 * soon, escalated, vacancy-gap suggestions) were removed — all covered by
 * cron-daily-wrapup's daily digest instead. This cron's non-email side
 * effects (WO auto-creation, priority escalation, audit logs) are unchanged.
 */
export const dailyMaintenanceScheduleCheck = inngest.createFunction(
  {
    id:      'cron-maintenance-schedule-check',
    name:    'Cron: Maintenance Schedule Alerts',
    retries: 2,
  },
  { cron: '0 13 * * *' },  // 8am CT (UTC-5)
  async ({ step, logger }) => {
    const today    = new Date()
    const todayStr = today.toISOString().split('T')[0]

    const alertDate = new Date(today)
    alertDate.setDate(alertDate.getDate() + ALERT_WINDOW_DAYS)

    // ── Pass 1: Due-soon schedules ─────────────────────────────────────────
    const dueSchedules = await step.run('find-due-schedules', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('maintenance_schedules')
        .select(`
          id, name, schedule_type, frequency, estimated_cost,
          instructions, auto_create_wo, next_due_date,
          active_from_month, active_to_month,
          assigned_vendor_id, property_id, org_id,
          properties ( name, city, state ),
          vendors ( id, name, email, portal_enabled )
        `)
        .eq('is_active', true)
        .lte('next_due_date', alertDate.toISOString().split('T')[0])
        .gte('next_due_date', todayStr)

      return data ?? []
    })

    logger.info(`Found ${dueSchedules.length} schedules due within ${ALERT_WINDOW_DAYS} days`)

    // ── Pass 2 lookup: Overdue schedules (fetched early to batch PM emails) ──
    const overdueSchedules = await step.run('find-overdue-schedules', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('maintenance_schedules')
        .select(`
          id, name, estimated_cost, next_due_date,
          assigned_vendor_id, property_id, org_id,
          properties ( name ),
          vendors ( name )
        `)
        .eq('is_active', true)
        .lt('next_due_date', todayStr)  // past due date

      return data ?? []
    })

    logger.info(`Found ${overdueSchedules.length} overdue schedules`)

    for (const schedule of dueSchedules) {
      const processResult = await step.run(`process-schedule-${schedule.id}`, async () => {
        const supabase = createServiceClient()
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
          // the schedule would get no PM-facing surface at all (no email,
          // since that was removed; not the digest either, since it's no
          // longer "due"). Reminder-only schedules stay due until the PM acts
          // on them manually (advanceScheduleAfterCompletion in
          // app/(dashboard)/maintenance/actions.ts advances next_due_date at
          // that point), so they keep showing up in the digest daily until then.
          if (schedule.schedule_type === 'routine' && schedule.frequency) {
            const nextDue = calcNextDueDate(schedule.frequency, dueDate)
            await supabase
              .from('maintenance_schedules')
              .update({ next_due_date: nextDue.toISOString().split('T')[0] })
              .eq('id', schedule.id)
              .eq('next_due_date', schedule.next_due_date!)  // optimistic lock — prevents double-advance on retry
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
    const escalateBefore = new Date(today)
    escalateBefore.setDate(escalateBefore.getDate() - ESCALATE_DAYS_PAST)

    for (const schedule of overdueSchedules) {
      await step.run(`escalate-overdue-${schedule.id}`, async () => {
        const supabase = createServiceClient()
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
        const { data: openWO } = await supabase
          .from('work_orders')
          .select('id, priority, status')
          .eq('source_schedule_id', schedule.id)
          .not('status', 'in', '("completed","cancelled")')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        // The PM-facing escalation alerts that used to fire here (both the
        // existing-WO-escalated and new-WO-created cases) are now covered
        // by cron-daily-wrapup's maintenance digest section instead.
        if (openWO) {
          // Escalate existing WO priority to urgent if not already
          if (openWO.priority !== 'urgent') {
            await supabase
              .from('work_orders')
              .update({ priority: 'urgent' })
              .eq('id', openWO.id)

            await supabase.from('work_order_updates').insert({
              work_order_id:             openWO.id,
              org_id:                    schedule.org_id,
              updated_via_vendor_portal: false,
              status_from:               openWO.status,
              status_to:                 openWO.status,
              notes:                     `Priority auto-escalated to Urgent — ${daysLate} day${daysLate !== 1 ? 's' : ''} past scheduled date`,
            })

            await logAuditEvent({
              orgId:      schedule.org_id,
              action:     'work_order.updated',
              targetType: 'work_order',
              targetId:   openWO.id,
              metadata:   { change: 'auto_escalated_to_urgent', maintenance_schedule_id: schedule.id },
            })
          }
        } else {
          // No open WO — create one with urgent priority
          // Idempotency: skip insert if a WO already exists for this schedule + due date
          const { data: existingWO } = await supabase
            .from('work_orders')
            .select('id')
            .eq('source_schedule_id', schedule.id)
            .eq('scheduled_date', schedule.next_due_date!)
            .eq('source', 'maintenance_schedule')
            .maybeSingle()

          const { data: wo } = existingWO
            ? { data: existingWO }
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

    // ── Pass 3: Vacancy-gap maintenance suggestions ─────────────────────────
    const gapSuggestions = await step.run('find-vacancy-gaps', async () => {
      const supabase = createServiceClient()

      // ── 1. All active properties ───────────────────────────────────────────
      const { data: properties } = await supabase
        .from('properties')
        .select('id, org_id, name')
        .eq('is_active', true)

      if (!properties?.length) return []

      const propertyIds = properties.map((p) => p.id)

      // ── 2. ONE batch bookings query for all properties ─────────────────────
      //    Replaces the previous per-property query (N round trips → 1).
      const { data: allBookings } = await supabase
        .from('bookings')
        .select('property_id, checkin_date, checkout_date')
        .in('property_id', propertyIds)
        .in('status', ['confirmed', 'tentative'])
        .gte('checkout_date', todayStr)
        .order('property_id',  { ascending: true })
        .order('checkin_date', { ascending: true })

      const bookingsByProperty = new Map<string, GapBooking[]>()
      for (const booking of allBookings ?? []) {
        const existing = bookingsByProperty.get(booking.property_id) ?? []
        existing.push({ checkin_date: booking.checkin_date, checkout_date: booking.checkout_date })
        bookingsByProperty.set(booking.property_id, existing)
      }

      // ── 3. ONE batch maintenance_schedules query for all properties ────────
      //    Replaces the per-gap query inside findMaintenanceCandidatesForWindow.
      //    The window/seasonal filtering it did is reproduced in memory by
      //    computeVacancyGaps() below.
      const { data: allSchedules } = await supabase
        .from('maintenance_schedules')
        .select('id, property_id, name, next_due_date, estimated_cost, assigned_vendor_id, active_from_month, active_to_month')
        .in('property_id', propertyIds)
        .eq('is_active', true)

      const schedulesByProperty = new Map<string, GapScheduleRow[]>()
      for (const schedule of (allSchedules ?? []) as GapScheduleRow[]) {
        const existing = schedulesByProperty.get(schedule.property_id) ?? []
        existing.push(schedule)
        schedulesByProperty.set(schedule.property_id, existing)
      }

      // ── 4. Compute gaps + candidates entirely in memory — zero DB round trips ─
      return computeVacancyGaps(properties, bookingsByProperty, schedulesByProperty)
    })

    // gapSuggestions used to be emailed to the PM here — superseded by
    // cron-daily-wrapup's Monday-only vacancy section (a simpler gap-detection
    // query, not a port of this file's fuller candidate-scoring logic).

    // ── Thirty-day milestone ────────────────────────────────────────────────
    // Only look at orgs that just crossed the 30-day mark since roughly the last run
    // (2-day lookback window for safety) instead of re-scanning every org that has
    // ever existed — the upsert's ignoreDuplicates guards against overlap/reruns.
    await step.run('check-thirty-day-milestone', async () => {
      const supabase = createServiceClient()
      const windowStart = new Date(Date.now() - 32 * 86_400_000).toISOString()
      const windowEnd   = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const { data: orgs } = await supabase
        .from('organizations')
        .select('id')
        .gte('created_at', windowStart)
        .lte('created_at', windowEnd)

      if (orgs?.length) {
        await supabase.from('org_milestones').upsert(
          orgs.map(org => ({ org_id: org.id, milestone: 'thirty_days' })),
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
      }
    })

    return {
      checked:        dueSchedules.length,
      escalated:      overdueSchedules.length,
      gapSuggestions: gapSuggestions.length,
    }
  }
)
