import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'

// ── Work Order Created ────────────────────────────────────────────────────────

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

        const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/work-orders/${wo.completion_token}`

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
              <p><a href="${portalUrl}" style="background:#FCD116;color:#0a1628;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:700">Mark as Complete →</a></p>
              <p style="color:#94a3b8;font-size:12px;margin-top:24px">This link expires in 30 days.</p>
            </div>
          `,
        })

        logger.info(`Sent vendor portal link to ${vendor.email} for WO ${work_order_id}`)
      })
    }

    if (event.data.vendor_id) {
      await step.run('schedule-overdue-check', async () => {
        const supabase = createServiceClient()
        const { data: wo } = await supabase
          .from('work_orders')
          .select('scheduled_date')
          .eq('id', work_order_id)
          .single()

        if (!wo?.scheduled_date) return

        await inngest.send({
          name: 'work-order/overdue' as const,
          data: {
            work_order_id,
            property_id,
            org_id,
            scheduled_date: wo.scheduled_date,
            days_overdue:   3,
          },
        })
      })
    }

    return { work_order_id }
  }
)

// ── Work Order Completed via Portal ──────────────────────────────────────────

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

      const cost = wo.actual_cost
      if (property && cost && cost > 0) {
        const { count } = await supabase
          .from('owner_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('work_order_id', work_order_id)

        if ((count ?? 0) === 0) {
          await supabase.from('owner_transactions').insert({
            property_id:      (property as { id: string }).id,
            org_id:           wo.org_id,
            work_order_id,
            transaction_type: 'expense',
            category:         'maintenance',
            amount:           cost,
            description:      wo.title,
            transaction_date: new Date().toISOString().split('T')[0],
            notes:            'Auto-created from vendor portal completion',
          })
        }
      }

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
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/maintenance?wo=${work_order_id}" style="background:#FCD116;color:#0a1628;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:700">View Work Order →</a></p>
          </div>
        `,
      })
    })

    return { work_order_id, notified: true }
  }
)

// ── Work Order Overdue ────────────────────────────────────────────────────────

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

      const { data: wo } = await supabase
        .from('work_orders')
        .select('id, title, status, scheduled_date, vendors(name), properties(name)')
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
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/maintenance" style="background:#FCD116;color:#0a1628;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:700">Review Work Orders →</a></p>
          </div>
        `,
      })
    })

    return { work_order_id, alerted: true }
  }
)

// ── Quote Requested ───────────────────────────────────────────────────────────

export const handleWorkOrderQuoteRequested = inngest.createFunction(
  {
    id:      'work-order-quote-requested',
    name:    'Work Order Quote Requested',
    retries: 2,
  },
  { event: 'work-order/quote-requested' as const },
  async ({ event, step, logger }) => {
    const { work_order_id, quote_request_id } = event.data

    await step.run('send-vendor-quote-request', async () => {
      const supabase = createServiceClient()

      const { data: qr } = await supabase
        .from('quote_requests')
        .select(`
          id, quote_token, status,
          work_orders (
            id, title, description, scheduled_date, estimated_cost,
            properties (name, city, state)
          ),
          vendors (name, email)
        `)
        .eq('id', quote_request_id)
        .single()

      if (!qr?.quote_token) return

      const wo       = Array.isArray(qr.work_orders) ? qr.work_orders[0] : qr.work_orders
      const vendor   = Array.isArray(qr.vendors)     ? qr.vendors[0]     : qr.vendors
      const property = wo && (Array.isArray(wo.properties) ? wo.properties[0] : wo.properties)

      if (!vendor?.email) {
        logger.warn(`Quote request ${quote_request_id}: vendor has no email`)
        return
      }

      const quoteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/work-orders/${qr.quote_token}/quote`

      await resend.emails.send({
        from:    FROM,
        to:      vendor.email,
        subject: `Quote requested — ${wo?.title} at ${property?.name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2>Quote Request</h2>
            <p>You've been asked to submit a quote for a job at <strong>${property?.name}</strong>.</p>
            <table style="border-collapse:collapse;width:100%;margin:16px 0">
              <tr><td style="padding:8px;color:#64748b">Job</td><td style="padding:8px;font-weight:600">${wo?.title}</td></tr>
              ${wo?.description ? `<tr><td style="padding:8px;color:#64748b">Details</td><td style="padding:8px">${wo.description}</td></tr>` : ''}
              ${wo?.scheduled_date ? `<tr><td style="padding:8px;color:#64748b">Target Date</td><td style="padding:8px;font-weight:600">${new Date(wo.scheduled_date).toLocaleDateString()}</td></tr>` : ''}
              ${wo?.estimated_cost ? `<tr><td style="padding:8px;color:#64748b">Budget Est.</td><td style="padding:8px">$${wo.estimated_cost}</td></tr>` : ''}
            </table>
            <p>Click below to view the job details and submit your quote:</p>
            <p><a href="${quoteUrl}" style="background:#FCD116;color:#0a1628;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:700">Submit Quote →</a></p>
            <p style="color:#94a3b8;font-size:12px;margin-top:24px">This link expires in 14 days.</p>
          </div>
        `,
      })

      logger.info(`Sent quote request to ${vendor.email} for WO ${work_order_id}`)
    })

    return { work_order_id }
  }
)

// ── Quote Submitted ───────────────────────────────────────────────────────────

export const handleWorkOrderQuoteSubmitted = inngest.createFunction(
  {
    id:      'work-order-quote-submitted',
    name:    'Work Order Quote Submitted',
    retries: 2,
  },
  { event: 'work-order/quote-submitted' as const },
  async ({ event, step }) => {
    const { work_order_id, quote_request_id, org_id, quoted_amount, quote_notes } = event.data

    await step.run('notify-pm-of-quote', async () => {
      const supabase = createServiceClient()

      const { data: wo } = await supabase
        .from('work_orders')
        .select('id, title, vendors ( name ), properties ( name )')
        .eq('id', work_order_id)
        .single()

      if (!wo) return

      const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

      const { data: adminMember } = await supabase
        .from('organization_members')
        .select('user_id')
        .eq('org_id', org_id)
        .eq('role', 'admin')
        .single()

      if (!adminMember?.user_id) return

      const { data: { user } } = await supabase.auth.admin.getUserById(adminMember.user_id)
      if (!user?.email) return

      await resend.emails.send({
        from:    FROM,
        to:      user.email,
        subject: `💬 Quote received — ${wo.title} at ${property?.name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2>Quote received</h2>
            <p><strong>${vendor?.name ?? 'Your vendor'}</strong> has submitted a quote for <strong>${wo.title}</strong>.</p>
            <table style="border-collapse:collapse;width:100%;margin:16px 0">
              <tr><td style="padding:8px;color:#64748b">Property</td><td style="padding:8px;font-weight:600">${property?.name}</td></tr>
              <tr style="background:#f8fafc"><td style="padding:8px;color:#64748b">Quoted Amount</td><td style="padding:8px;font-weight:600;font-size:18px">$${quoted_amount.toFixed(2)}</td></tr>
              ${quote_notes ? `<tr><td style="padding:8px;color:#64748b">Vendor Notes</td><td style="padding:8px">${quote_notes}</td></tr>` : ''}
            </table>
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/maintenance" style="background:#FCD116;color:#0a1628;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:700">Review Quote →</a></p>
          </div>
        `,
      })
    })

    return { work_order_id, notified: true }
  }
)
