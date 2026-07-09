import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { renderVendorInvoicePaidEmail } from '@/lib/resend/emails/vendor-invoice-paid'

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
      const supabase = createServiceClient()

      const [{ data: wo }, { data: invoice }] = await Promise.all([
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

      if (!wo || !invoice) {
        logger.warn(`[invoice-paid] WO or invoice not found`, { work_order_id, invoice_id })
        return
      }

      const vendor   = Array.isArray(wo.vendors)    ? wo.vendors[0]    : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

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
