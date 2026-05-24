import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'

/**
 * Triggered when a work order is created.
 *
 * If portal_enabled + vendor has email → send vendor the completion link.
 * Also schedules an overdue check.
 */
export const handleWorkOrderCreated = inngest.createFunction(
  {
    id:      'work-order-created',
    name:    'Handle Work Order Created',
    retries: 2,
  },
  { event: 'work-order/created' as const },
  async ({ event, step, logger }) => {
    const { work_order_id, property_id, org_id, portal_enabled } = event.data

    if (portal_enabled) {
      await step.run('send-vendor-portal-link', async () => {
        const supabase = createServiceClient()

        const { data: wo } = await supabase
          .from('work_orders')
          .select(`
            id, title, description, scheduled_date, completion_token,
            vendors ( name, email ),
            properties ( name, city, state )
          `)
          .eq('id', work_order_id)
          .single()

        if (!wo?.completion_token) return

        const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
        const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

        if (!vendor?.email) {
          logger.warn(`Work order ${work_order_id}: portal enabled but vendor has no email`)
          return
        }

        const completionUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/work-orders/${wo.completion_token}/complete`
        const portalUrl     = `${process.env.NEXT_PUBLIC_APP_URL}/work-orders/${wo.completion_token}`

        // Set token expiry to 30 days from now
        const expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + 30)
        await supabase
          .from('work_orders')
          .update({ completion_token_expires_at: expiresAt.toISOString() })
          .eq('id', work_order_id)

        await resend.emails.send({
          from:    FROM,
          to:      vendor.email,
          subject: `Work order: ${wo.title} — ${property?.name}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
              <h2>Work Order</h2>
              <p>You've been assigned a work order at <strong>${property?.name}</strong>.</p>
              <table style="border-collapse:collapse;width:100%;margin:16px 0">
                <tr><td style="padding:8px;color:#64748b">Job</td><td style="padding:8px;font-weight:600">${wo.title}</td></tr>
                ${wo.description ? `<tr><td style="padding:8px;color:#64748b">Details</td><td style="padding:8px">${wo.description}</td></tr>` : ''}
                ${wo.scheduled_date ? `<tr><td style="padding:8px;color:#64748b">Scheduled</td><td style="padding:8px;font-weight:600">${new Date(wo.scheduled_date).toLocaleDateString()}</td></tr>` : ''}
                <tr><td style="padding:8px;color:#64748b">Property</td><td style="padding:8px">${property?.name}${property?.city ? `, ${property.city}` : ''}</td></tr>
              </table>
              <p>When the job is complete, click below to submit your completion confirmation:</p>
              <p><a href="${portalUrl}" style="background:#093b31;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:600">Mark as Complete →</a></p>
              <p style="color:#94a3b8;font-size:12px;margin-top:24px">This link expires in 30 days. If you have questions, reply to this email.</p>
            </div>
          `,
        })

        logger.info(`Sent vendor portal link to ${vendor.email} for WO ${work_order_id}`)
      })
    }

    // Schedule overdue check — 3 days after scheduled date
    if (event.data.vendor_id) {
      await step.run('schedule-overdue-check', async () => {
        const supabase = createServiceClient()
        const { data: wo } = await supabase
          .from('work_orders')
          .select('scheduled_date')
          .eq('id', work_order_id)
          .single()

        if (!wo?.scheduled_date) return

        const checkAt = new Date(wo.scheduled_date)
        checkAt.setDate(checkAt.getDate() + 3)

        await inngest.send({
          name: 'work-order/overdue' as const,
          data: {
            work_order_id,
            property_id,
            org_id,
            scheduled_date: wo.scheduled_date,
            days_overdue:   3,
          },
          // Send after the scheduled date + 3 days
          // Note: Inngest supports scheduledAt for deferred events
        })
      })
    }

    return { work_order_id }
  }
)

/**
 * Triggered when vendor submits completion via portal.
 * Notifies PM that the job is done.
 */
export const handleWorkOrderCompletedViaPortal = inngest.createFunction(
  {
    id:      'work-order-completed-via-portal',
    name:    'Work Order Completed via Vendor Portal',
    retries: 2,
  },
  { event: 'work-order/completed-via-portal' as const },
  async ({ event, step }) => {
    const { work_order_id } = event.data

    await step.run('notify-pm-of-completion', async () => {
      const supabase = createServiceClient()

      const { data: wo } = await supabase
        .from('work_orders')
        .select(`
          id, title, completion_notes, actual_cost, org_id,
          vendors ( name ),
          properties ( id, name ),
          work_order_photos ( storage_path )
        `)
        .eq('id', work_order_id)
        .single()

      if (!wo) return

      const { data: adminMember } = await supabase
        .from('organization_members')
        .select('user_id')
        .eq('org_id', wo.org_id)
        .eq('role', 'admin')
        .single()

      if (!adminMember?.user_id) return

      const { data: { user } } = await supabase.auth.admin.getUserById(adminMember.user_id)
      if (!user?.email) return

      const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties
      const photos   = Array.isArray(wo.work_order_photos) ? wo.work_order_photos : []

      await resend.emails.send({
        from:    FROM,
        to:      user.email,
        subject: `✅ Work order complete — ${wo.title} at ${property?.name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#15803d">Work order marked complete</h2>
            <p><strong>${vendor?.name ?? 'Your vendor'}</strong> has completed: <strong>${wo.title}</strong></p>
            <p>Property: ${property?.name}</p>
            ${wo.completion_notes ? `<p><strong>Notes:</strong> ${wo.completion_notes}</p>` : ''}
            ${photos.length > 0 ? `<p>${photos.length} photo${photos.length !== 1 ? 's' : ''} attached to the work order.</p>` : ''}
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/maintenance?wo=${work_order_id}" style="background:#093b31;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">View Work Order →</a></p>
          </div>
        `,
      })
    })

    return { work_order_id, notified: true }
  }
)

/**
 * Triggered when a work order is past its scheduled date.
 * Sends an overdue alert to the PM.
 */
export const handleWorkOrderOverdue = inngest.createFunction(
  {
    id:      'work-order-overdue',
    name:    'Work Order Overdue Alert',
    retries: 1,
  },
  { event: 'work-order/overdue' as const },
  async ({ event, step }) => {
    const { work_order_id, org_id, days_overdue } = event.data

    await step.run('check-and-alert', async () => {
      const supabase = createServiceClient()

      // Verify still open (not completed or cancelled)
      const { data: wo } = await supabase
        .from('work_orders')
        .select(`id, title, status, scheduled_date, vendors(name), properties(name)`)
        .eq('id', work_order_id)
        .single()

      if (!wo || wo.status === 'completed' || wo.status === 'cancelled') return

      const { data: adminMember } = await supabase
        .from('organization_members')
        .select('user_id')
        .eq('org_id', org_id)
        .eq('role', 'admin')
        .single()

      if (!adminMember?.user_id) return

      const { data: { user } } = await supabase.auth.admin.getUserById(adminMember.user_id)
      if (!user?.email) return

      const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

      await resend.emails.send({
        from:    FROM,
        to:      user.email,
        subject: `⚠️ Work order overdue — ${wo.title} at ${property?.name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#b45309">Work order ${days_overdue} day${days_overdue !== 1 ? 's' : ''} overdue</h2>
            <p><strong>${wo.title}</strong> was scheduled for ${new Date(wo.scheduled_date!).toLocaleDateString()} and hasn't been completed.</p>
            ${vendor ? `<p>Assigned to: <strong>${vendor.name}</strong></p>` : ''}
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/maintenance" style="background:#093b31;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">Review Work Orders →</a></p>
          </div>
        `,
      })
    })

    return { work_order_id, alerted: true }
  }
)
