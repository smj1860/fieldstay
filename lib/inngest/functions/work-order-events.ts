import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { WorkOrderVendorEmail } from '@/lib/resend/emails/work-order-vendor'
import { getPmEmail } from '@/lib/inngest/helpers'

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
            id, title, description, wo_number, wo_category, priority_level,
            scheduled_date, estimated_cost, nte_amount, completion_token,
            completion_token_expires_at,
            vendors ( name, email ),
            properties ( name, address_line1, city, state, zip )
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

        const EXPIRES_IN_DAYS = 30
        await resend.emails.send({
          from:    FROM,
          to:      vendor.email,
          subject: `Work Order${wo.wo_number ? ` #${wo.wo_number}` : ''}: ${wo.title} — ${property?.name}`,
          react:   WorkOrderVendorEmail({
            wo_number:       wo.wo_number ?? null,
            title:           wo.title,
            description:     wo.description ?? null,
            wo_category:     wo.wo_category ?? null,
            priority_level:  wo.priority_level ?? null,
            scheduled_date:  wo.scheduled_date ?? null,
            nte_amount:      (wo as { nte_amount?: number | null }).nte_amount ?? null,
            property_name:   property?.name ?? '',
            address_line1:   (property as { address_line1?: string | null } | null)?.address_line1 ?? null,
            city:            property?.city ?? null,
            state:           property?.state ?? null,
            zip:             (property as { zip?: string | null } | null)?.zip ?? null,
            portal_url:      portalUrl,
            portal_type:     'complete',
            expires_in_days: EXPIRES_IN_DAYS,
          }),
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

// ── Work Order Completed (PM-side) ───────────────────────────────────────────

export const handleWorkOrderCompleted = inngest.createFunction(
  { id: 'work-order-completed', name: 'Work Order Completed — Post Expense', retries: 3 },
  { event: 'work-order/completed' as const },
  async ({ event, step }) => {
    const { work_order_id, property_id, org_id } = event.data

    await step.run('post-wo-expense', async () => {
      const supabase = createServiceClient()

      const { data: wo } = await supabase
        .from('work_orders')
        .select('title, actual_cost, estimated_cost')
        .eq('id', work_order_id)
        .single()

      const cost = wo?.actual_cost ?? wo?.estimated_cost ?? null
      if (!cost || cost <= 0) return { skipped: true }

      const { data: existing } = await supabase
        .from('owner_transactions')
        .select('id')
        .eq('source_reference_id', work_order_id)
        .eq('source', 'wo_completion')
        .maybeSingle()

      if (existing) return { skipped: true }

      await supabase.from('owner_transactions').insert({
        property_id,
        org_id,
        source:               'wo_completion',
        source_reference_id:  work_order_id,
        transaction_type:     'expense',
        category:             'maintenance',
        amount:               cost,
        description:          wo?.title ?? 'Work order expense',
        transaction_date:     new Date().toISOString().split('T')[0],
        visible_to_owner:     false,
      })

      return { posted: cost }
    })

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

      const pmEmail = await getPmEmail(supabase, wo.org_id)
      if (!pmEmail) return

      const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties
      const photos   = Array.isArray(wo.work_order_photos) ? wo.work_order_photos : []

      const cost = wo.actual_cost
      if (property && cost && cost > 0) {
        const { data: existing } = await supabase
          .from('owner_transactions')
          .select('id')
          .eq('source_reference_id', work_order_id)
          .eq('source', 'wo_completion')
          .maybeSingle()

        if (!existing) {
          await supabase.from('owner_transactions').insert({
            property_id:          (property as { id: string }).id,
            org_id:               wo.org_id,
            work_order_id,
            source:               'wo_completion',
            source_reference_id:  work_order_id,
            transaction_type:     'expense',
            category:             'maintenance',
            amount:               cost,
            description:          wo.title,
            transaction_date:     new Date().toISOString().split('T')[0],
            notes:                'Auto-created from vendor portal completion',
          })
        }
      }

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
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

      const pmEmail = await getPmEmail(supabase, org_id)
      if (!pmEmail) return

      const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
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
            id, title, description, wo_number, wo_category, priority_level,
            scheduled_date, estimated_cost, nte_amount,
            properties (name, address_line1, city, state, zip)
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

      const QUOTE_EXPIRES_DAYS = 14
      await resend.emails.send({
        from:    FROM,
        to:      vendor.email,
        subject: `Quote Request${wo?.wo_number ? ` #${wo.wo_number}` : ''}: ${wo?.title} — ${property?.name}`,
        react:   WorkOrderVendorEmail({
          wo_number:       (wo as { wo_number?: string | null } | null)?.wo_number ?? null,
          title:           wo?.title ?? '',
          description:     wo?.description ?? null,
          wo_category:     (wo as { wo_category?: string | null } | null)?.wo_category ?? null,
          priority_level:  (wo as { priority_level?: string | null } | null)?.priority_level ?? null,
          scheduled_date:  wo?.scheduled_date ?? null,
          nte_amount:      (wo as { nte_amount?: number | null } | null)?.nte_amount ?? null,
          property_name:   property?.name ?? '',
          address_line1:   (property as { address_line1?: string | null } | null)?.address_line1 ?? null,
          city:            property?.city ?? null,
          state:           property?.state ?? null,
          zip:             (property as { zip?: string | null } | null)?.zip ?? null,
          portal_url:      quoteUrl,
          portal_type:     'quote',
          expires_in_days: QUOTE_EXPIRES_DAYS,
        }),
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

      const pmEmail = await getPmEmail(supabase, org_id)
      if (!pmEmail) return

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
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
