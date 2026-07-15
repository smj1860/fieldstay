import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { getPmEmailsByOrgIds } from '@/lib/inngest/helpers'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'
import { parseLocalDate } from '@/lib/utils/date-validation'
import { logAuditEvent } from '@/lib/audit'
import {
  createMaintenanceWorkOrder,
  sendDueSoonAlert,
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
 *   • auto_create_wo = true  → create WO + notify PM
 *   • auto_create_wo = false → alert email
 *
 * Pass 2 — overdue escalation: schedules past their due date
 *   • If an open WO exists for the schedule → bump priority to urgent
 *   • If no WO exists → create one (regardless of auto_create_wo) + alert PM
 *
 * Also handles the thirty-day org milestone check.
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

    // ── Batch-resolve PM emails for every org touched by either pass ────────
    const pmEmailEntries = await step.run('find-pm-emails', async () => {
      const supabase = createServiceClient()
      const orgIds = Array.from(new Set([
        ...dueSchedules.map((s) => s.org_id),
        ...overdueSchedules.map((s) => s.org_id),
      ]))
      const emails = await getPmEmailsByOrgIds(supabase, orgIds)
      return Array.from(emails.entries())
    })
    const pmEmailByOrg = new Map(pmEmailEntries)

    for (const schedule of dueSchedules) {
      const processResult = await step.run(`process-schedule-${schedule.id}`, async () => {
        const supabase = createServiceClient()
        const property = Array.isArray(schedule.properties) ? schedule.properties[0] : schedule.properties
        const vendor   = Array.isArray(schedule.vendors)   ? schedule.vendors[0]   : schedule.vendors

        let dueDate: Date
        try {
          dueDate = parseLocalDate(schedule.next_due_date, 'next_due_date')
        } catch (err) {
          console.error(`[maintenance-cron] invalid next_due_date on schedule ${schedule.id}`, {
            schedule_id:   schedule.id,
            next_due_date: schedule.next_due_date,
            error:         String(err),
          })
          return
        }
        const daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / 86_400_000)

        // Skip items outside their seasonal window — no WO, no alert
        if (!isMaintenanceItemActiveThisMonth(schedule.active_from_month ?? null, schedule.active_to_month ?? null)) {
          return
        }

        const pmEmail = pmEmailByOrg.get(schedule.org_id) ?? null

        let vendorPortalEvent: VendorPortalEvent | null = null
        if (schedule.auto_create_wo) {
          vendorPortalEvent = await createMaintenanceWorkOrder(supabase, schedule, property ?? null, vendor ?? null, dueDate, daysUntilDue, pmEmail)
        } else {
          await sendDueSoonAlert(pmEmail, schedule, property ?? null, vendor ?? null, dueDate, daysUntilDue)
        }

        // Advance next_due_date for routine schedules
        if (schedule.schedule_type === 'routine' && schedule.frequency) {
          const nextDue = calcNextDueDate(schedule.frequency, dueDate)
          await supabase
            .from('maintenance_schedules')
            .update({ next_due_date: nextDue.toISOString().split('T')[0] })
            .eq('id', schedule.id)
            .eq('next_due_date', schedule.next_due_date!)  // optimistic lock — prevents double-advance on retry
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
        const property = Array.isArray(schedule.properties) ? schedule.properties[0] : schedule.properties
        const vendor   = Array.isArray(schedule.vendors)   ? schedule.vendors[0]   : schedule.vendors
        let dueDate: Date
        try {
          dueDate = parseLocalDate(schedule.next_due_date, 'next_due_date')
        } catch (err) {
          console.error(`[maintenance-cron] invalid next_due_date in overdue pass for schedule ${schedule.id}`, {
            schedule_id:   schedule.id,
            next_due_date: schedule.next_due_date,
            error:         String(err),
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

        const pmEmail = pmEmailByOrg.get(schedule.org_id) ?? null

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

          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🚨 Overdue maintenance escalated — ${schedule.name} at ${property?.name}`,
              html: await renderPmAlert({
                heading:  'Overdue maintenance escalated to Urgent',
                body:     `${schedule.name} is ${daysLate} day${daysLate !== 1 ? 's' : ''} overdue. The linked work order has been escalated to Urgent priority.`,
                details: [
                  { label: 'Property',  value: property?.name ?? null },
                  { label: 'Due Date',  value: dueDate.toLocaleDateString() },
                  { label: 'Est. Cost', value: schedule.estimated_cost ? `$${schedule.estimated_cost}` : null },
                  { label: 'Vendor',    value: vendor?.name ?? null },
                ],
                ctaLabel: 'Review Work Order →',
                ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
              }),
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

          if (pmEmail && wo && !existingWO) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🚨 Overdue maintenance — urgent WO created — ${schedule.name} at ${property?.name}`,
              html: await renderPmAlert({
                heading:  'Overdue maintenance — urgent work order created',
                body:     `${schedule.name} is ${daysLate} day${daysLate !== 1 ? 's' : ''} overdue — a new work order has been created and marked Urgent.`,
                details: [
                  { label: 'Property',  value: property?.name ?? null },
                  { label: 'Due Date',  value: dueDate.toLocaleDateString() },
                  { label: 'Est. Cost', value: schedule.estimated_cost ? `$${schedule.estimated_cost}` : null },
                  { label: 'Vendor',    value: vendor?.name ?? null },
                ],
                ctaLabel: 'Assign Work Order →',
                ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
              }),
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

    if (gapSuggestions.length) {
      const gapPmEmails = await step.run('find-pm-emails-gaps', async () => {
        const supabase = createServiceClient()
        const orgIds = Array.from(new Set(gapSuggestions.map(g => g.org_id)))
        const emails = await getPmEmailsByOrgIds(supabase, orgIds)
        return Array.from(emails.entries())
      })
      const gapPmByOrg = new Map(gapPmEmails)

      for (const gap of gapSuggestions) {
        await step.run(`notify-gap-${gap.property_id}-${gap.gap_start}`, async () => {
          const pmEmail = gapPmByOrg.get(gap.org_id)
          if (!pmEmail) return

          const tierLabel = gap.tier === 'strong' ? 'Vacancy opportunity' : 'Possible vacancy window'
          const items = gap.candidates
            .map(c => `${c.name}${c.estimated_cost ? ' (~$' + c.estimated_cost + ')' : ''}`)
            .join(', ')

          await resend.emails.send(
            {
              from:    FROM,
              to:      pmEmail,
              subject: `${tierLabel} — ${gap.property_name}, ${gap.gap_days} days`,
              html: await renderPmAlert({
                heading: tierLabel,
                body:    `${gap.property_name} has a ${gap.gap_days}-day gap starting ${new Date(gap.gap_start).toLocaleDateString()}${gap.gap_end ? '' : ' (no booking on the books yet)'}. Consider scheduling: ${items}.`,
                details: gap.candidates.slice(0, 5).map(c => ({
                  label: c.name,
                  value: c.estimated_cost ? `~$${c.estimated_cost}` : 'Cost TBD',
                })),
                ctaLabel: 'Review Maintenance →',
                ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
              }),
            },
            { idempotencyKey: `vacancy-gap-${gap.property_id}-${gap.gap_start}` }
          )
        })
      }
    }

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
