import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { getPmEmail, buildScheduleEmail } from '@/lib/inngest/helpers'

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
    const supabase  = createServiceClient()
    const today     = new Date()
    const todayStr  = today.toISOString().split('T')[0]

    const alertDate = new Date(today)
    alertDate.setDate(alertDate.getDate() + ALERT_WINDOW_DAYS)

    // ── Pass 1: Due-soon schedules ─────────────────────────────────────────
    const dueSchedules = await step.run('find-due-schedules', async () => {
      const { data } = await supabase
        .from('maintenance_schedules')
        .select(`
          id, name, schedule_type, frequency, estimated_cost,
          instructions, auto_create_wo, next_due_date,
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

    for (const schedule of dueSchedules) {
      await step.run(`process-schedule-${schedule.id}`, async () => {
        const property = Array.isArray(schedule.properties) ? schedule.properties[0] : schedule.properties
        const vendor   = Array.isArray(schedule.vendors)   ? schedule.vendors[0]   : schedule.vendors

        const dueDate      = new Date(schedule.next_due_date!)
        const daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / 86_400_000)

        const pmEmail = await getPmEmail(supabase, schedule.org_id)

        if (schedule.auto_create_wo) {
          const { data: wo } = await supabase
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

          if (pmEmail && wo) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `Work order created — ${schedule.name} at ${property?.name}`,
              html: buildScheduleEmail({
                heading:  'Scheduled maintenance work order created',
                name:     schedule.name,
                daysText: `due in <strong>${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</strong>`,
                property: property?.name,
                dueDate:  dueDate.toLocaleDateString(),
                cost:     schedule.estimated_cost,
                vendor:   vendor?.name,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
                cta:      'View Work Order →',
              }),
            })
          }

          if (wo && vendor?.email && vendor?.portal_enabled) {
            await inngest.send({
              name: 'work-order/created' as const,
              data: {
                work_order_id: wo.id,
                property_id:   schedule.property_id,
                org_id:        schedule.org_id,
                vendor_id:     vendor.id,
                portal_enabled: true,
              },
            })
          }
        } else {
          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🔧 Maintenance due soon — ${schedule.name} at ${property?.name}`,
              html: buildScheduleEmail({
                heading:  'Scheduled maintenance coming up',
                name:     schedule.name,
                daysText: `due in <strong>${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</strong>`,
                property: property?.name,
                dueDate:  dueDate.toLocaleDateString(),
                cost:     schedule.estimated_cost,
                vendor:   vendor?.name,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
                cta:      'Create Work Order →',
              }),
            })
          }
        }

        // Advance next_due_date for routine schedules
        if (schedule.schedule_type === 'routine' && schedule.frequency) {
          const nextDue = calcNextDueDate(schedule.frequency, dueDate)
          await supabase
            .from('maintenance_schedules')
            .update({ next_due_date: nextDue.toISOString().split('T')[0] })
            .eq('id', schedule.id)
        }
      })
    }

    // ── Pass 2: Overdue escalation ─────────────────────────────────────────
    const escalateBefore = new Date(today)
    escalateBefore.setDate(escalateBefore.getDate() - ESCALATE_DAYS_PAST)

    const overdueSchedules = await step.run('find-overdue-schedules', async () => {
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

    for (const schedule of overdueSchedules) {
      await step.run(`escalate-overdue-${schedule.id}`, async () => {
        const property = Array.isArray(schedule.properties) ? schedule.properties[0] : schedule.properties
        const vendor   = Array.isArray(schedule.vendors)   ? schedule.vendors[0]   : schedule.vendors
        const dueDate  = new Date(schedule.next_due_date!)
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

        const pmEmail = await getPmEmail(supabase, schedule.org_id)

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
          }

          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🚨 Overdue maintenance escalated — ${schedule.name} at ${property?.name}`,
              html: buildScheduleEmail({
                heading:  `Overdue maintenance escalated to Urgent`,
                name:     schedule.name,
                daysText: `<strong>${daysLate} day${daysLate !== 1 ? 's' : ''} overdue</strong>`,
                property: property?.name,
                dueDate:  dueDate.toLocaleDateString(),
                cost:     schedule.estimated_cost,
                vendor:   vendor?.name,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
                cta:      'Review Work Order →',
              }),
            })
          }
        } else {
          // No open WO — create one with urgent priority
          const { data: wo } = await supabase
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

          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🚨 Overdue maintenance — urgent WO created — ${schedule.name} at ${property?.name}`,
              html: buildScheduleEmail({
                heading:  'Overdue maintenance — urgent work order created',
                name:     schedule.name,
                daysText: `<strong>${daysLate} day${daysLate !== 1 ? 's' : ''} overdue</strong> — marked Urgent`,
                property: property?.name,
                dueDate:  dueDate.toLocaleDateString(),
                cost:     schedule.estimated_cost,
                vendor:   vendor?.name,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
                cta:      'Assign Work Order →',
              }),
            })
          }
        }
      })
    }

    // ── Thirty-day milestone ────────────────────────────────────────────────
    await step.run('check-thirty-day-milestone', async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const { data: orgs } = await supabase
        .from('organizations')
        .select('id')
        .lte('created_at', thirtyDaysAgo)

      for (const org of orgs ?? []) {
        await supabase.from('org_milestones').upsert(
          { org_id: org.id, milestone: 'thirty_days' },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
      }
    })

    return {
      checked:   dueSchedules.length,
      escalated: overdueSchedules.length,
    }
  }
)
