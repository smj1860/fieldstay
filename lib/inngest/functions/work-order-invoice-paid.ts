import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { renderVendorInvoicePaidEmail } from '@/lib/resend/emails/vendor-invoice-paid'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'

// Fired by app/api/webhooks/stripe/route.ts on checkout.session.completed for
// a work order invoice — this was previously emitted with zero subscribers,
// so a paid vendor got no notification at all beyond whatever they noticed
// in their own bank account.
export const handleWorkOrderInvoicePaid = inngest.createFunction(
  {
    id:      'work-order-invoice-paid',
    name:    'Work Order Invoice Paid — Notify Vendor',
    retries: 3,
  },
  { event: 'work-order/invoice-paid' as const },
  async ({ event, step, logger }) => {
    const { work_order_id, invoice_id, org_id } = event.data

    await step.run('notify-vendor-of-payment', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-invoice-paid' })

      const [woResult, invoiceResult] = await Promise.all([
        supabase
          .from('work_orders')
          .select('id, title, wo_number, vendors ( name, email ), properties ( name )')
          .eq('id', work_order_id)
          .eq('org_id', org_id)
          .single(),
        supabase
          .from('work_order_invoices')
          .select('id, invoice_number, total')
          .eq('id', invoice_id)
          .eq('org_id', org_id)
          .single(),
      ])

      // PGRST116 = no matching row, a genuine "not found" — anything else is
      // a real query failure and should be retried, not silently treated the
      // same as "not found" and logged at warn.
      if (woResult.error && woResult.error.code !== 'PGRST116') {
        throw new Error(`work_orders query failed: ${woResult.error.message}`)
      }
      if (invoiceResult.error && invoiceResult.error.code !== 'PGRST116') {
        throw new Error(`work_order_invoices query failed: ${invoiceResult.error.message}`)
      }

      const wo      = woResult.data
      const invoice = invoiceResult.data

      if (!wo || !invoice) {
        logger.warn(`[invoice-paid] WO or invoice not found`, { work_order_id, invoice_id })
        return
      }

      const vendor   = unwrapJoin(wo.vendors)
      const property = unwrapJoin(wo.properties)

      if (!vendor?.email) {
        logger.warn(`[invoice-paid] no vendor email for work order ${work_order_id}`)
        return
      }

      const { data: org } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', org_id)
        .single()

      await resend.emails.send(
        {
          from:    FROM,
          to:      vendor.email,
          subject: `💸 You've been paid ${invoice.total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} — ${wo.title}`,
          html: await renderVendorInvoicePaidEmail({
            vendorName:    vendor.name ?? null,
            orgName:       org?.name ?? 'Your property manager',
            woTitle:       wo.title,
            woNumber:      wo.wo_number ?? null,
            propertyName:  property?.name ?? null,
            invoiceNumber: invoice.invoice_number,
            amountPaid:    invoice.total,
          }),
        },
        { idempotencyKey: `work-order-invoice-paid-${invoice_id}` }
      )
    })

    return { work_order_id, invoice_id, notified: true }
  }
)
