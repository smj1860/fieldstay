import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'

const ALERT_WINDOW_DAYS = 7  // alert PM when schedule is due within 7 days

/**
 * SCHEDULED: runs every morning at 8am.
 *
 * Scans all active maintenance schedules. For each schedule due
 * within ALERT_WINDOW_DAYS:
 *   - If auto_create_wo = true: create a work order and notify PM
 *   - If auto_create_wo = false: send an alert email to PM
 */
export const dailyMaintenanceCheck = inngest.createFunction(
  {
    id:   'maintenance-daily-check',
    name: 'Daily Maintenance Check',
  },
  { cron: '0 13 * * *' },  // 8am CT (UTC-5)
  async ({ step, logger }) => {
    const supabase  = createServiceClient()
    const today     = new Date()
    const alertDate = new Date(today)
    alertDate.setDate(alertDate.getDate() + ALERT_WINDOW_DAYS)

    // Find all schedules due within the alert window
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
        .gte('next_due_date', today.toISOString().split('T')[0])

      return data ?? []
    })

    logger.info(`Found ${dueSchedules.length} schedules due within ${ALERT_WINDOW_DAYS} days`)

    if (dueSchedules.length === 0) return { checked: 0 }

    // Process each schedule
    for (const schedule of dueSchedules) {
      await step.run(`process-schedule-${schedule.id}`, async () => {
        const property = Array.isArray(schedule.properties)
          ? schedule.properties[0]
          : schedule.properties

        const vendor = Array.isArray(schedule.vendors)
          ? schedule.vendors[0]
          : schedule.vendors

        const dueDate     = new Date(schedule.next_due_date!)
        const daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / 86_400_000)

        // Get PM email
        const { data: adminMember } = await supabase
          .from('organization_members')
          .select('user_id')
          .eq('org_id', schedule.org_id)
          .eq('role', 'admin')
          .single()

        let pmEmail: string | null = null
        if (adminMember?.user_id) {
          const { data: { user } } = await supabase.auth.admin.getUserById(adminMember.user_id)
          pmEmail = user?.email ?? null
        }

        if (schedule.auto_create_wo) {
          // Auto-create work order
          const { data: wo } = await supabase
            .from('work_orders')
            .insert({
              property_id:       schedule.property_id,
              org_id:            schedule.org_id,
              vendor_id:         schedule.assigned_vendor_id ?? null,
              title:             schedule.name,
              description:       schedule.instructions,
              priority:          daysUntilDue <= 1 ? 'urgent' : daysUntilDue <= 3 ? 'high' : 'medium',
              status:            'pending',
              source:            'maintenance_schedule',
              source_schedule_id: schedule.id,
              scheduled_date:    schedule.next_due_date,
              estimated_cost:    schedule.estimated_cost,
              portal_enabled:    vendor?.portal_enabled ?? false,
            })
            .select('id')
            .single()

          // Notify PM of auto-created WO
          if (pmEmail && wo) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `Work order created — ${schedule.name} at ${property?.name}`,
              html: `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                  <h2>Scheduled maintenance work order created</h2>
                  <p><strong>${schedule.name}</strong> is due in <strong>${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</strong>.</p>
                  <table style="border-collapse:collapse;width:100%;margin:16px 0">
                    <tr><td style="padding:8px;color:#64748b">Property</td><td style="padding:8px;font-weight:600">${property?.name}</td></tr>
                    <tr><td style="padding:8px;color:#64748b">Due</td><td style="padding:8px;font-weight:600">${dueDate.toLocaleDateString()}</td></tr>
                    ${schedule.estimated_cost ? `<tr><td style="padding:8px;color:#64748b">Est. Cost</td><td style="padding:8px;font-weight:600">$${schedule.estimated_cost}</td></tr>` : ''}
                    ${vendor ? `<tr><td style="padding:8px;color:#64748b">Vendor</td><td style="padding:8px;font-weight:600">${vendor.name}</td></tr>` : ''}
                  </table>
                  <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/maintenance" style="background:#093b31;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">View Work Order →</a></p>
                </div>
              `,
            })
          }

          // If vendor portal enabled, send vendor the completion link
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
          // Just alert the PM
          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🔧 Maintenance due soon — ${schedule.name} at ${property?.name}`,
              html: `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                  <h2>Scheduled maintenance coming up</h2>
                  <p><strong>${schedule.name}</strong> is due in <strong>${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</strong>.</p>
                  <table style="border-collapse:collapse;width:100%;margin:16px 0">
                    <tr><td style="padding:8px;color:#64748b">Property</td><td style="padding:8px;font-weight:600">${property?.name}</td></tr>
                    <tr><td style="padding:8px;color:#64748b">Due Date</td><td style="padding:8px;font-weight:600">${dueDate.toLocaleDateString()}</td></tr>
                    ${schedule.estimated_cost ? `<tr><td style="padding:8px;color:#64748b">Est. Cost</td><td style="padding:8px;font-weight:600">$${schedule.estimated_cost}</td></tr>` : ''}
                    ${schedule.instructions ? `<tr><td style="padding:8px;color:#64748b">Instructions</td><td style="padding:8px">${schedule.instructions}</td></tr>` : ''}
                  </table>
                  <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/maintenance" style="background:#093b31;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">Create Work Order →</a></p>
                </div>
              `,
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
        // Seasonal schedules advance to same month next year — already correct
      })
    }

    return { checked: dueSchedules.length }
  }
)
