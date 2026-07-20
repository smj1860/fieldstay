import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { getPmEmails }         from '@/lib/inngest/helpers'
import { renderPmAlert }       from '@/lib/resend/emails/pm-alert'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'

export const handleWorkOrderInvoiceSubmitted = inngest.createFunction(
  {
    id:      'work-order-invoice-submitted',
    name:    'Work Order Invoice Submitted — Notify PM',
    retries: 3,
  },
  { event: 'work-order/invoice-submitted' as const },
  async ({ event, step, logger }) => {
    const { work_order_id, invoice_id, org_id } = event.data

    await step.run('notify-pm-of-invoice', async () => {
      const supabase = createServiceClient()

      const [{ data: wo }, { data: invoice }] = await Promise.all([
        supabase
          .from('work_orders')
          .select('id, title, vendors ( name ), properties ( name )')
          .eq('id', work_order_id)
          .eq('org_id', org_id)
          .single(),
        supabase
          .from('work_order_invoices')
          .select('id, invoice_number, subtotal, total, status')
          .eq('id', invoice_id)
          .eq('org_id', org_id)
          .single(),
      ])

      if (!wo || !invoice) {
        logger.warn(`[invoice-submitted] WO or invoice not found`, { work_order_id, invoice_id })
        return
      }

      const vendor   = unwrapJoin(wo.vendors)
      const property = unwrapJoin(wo.properties)

      const [pmEmail] = await getPmEmails(supabase, org_id)
      if (!pmEmail) {
        logger.warn(`[invoice-submitted] no PM email for org ${org_id}`)
        return
      }

      const invoiceUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invoices/${invoice_id}`

      const fmt = (n: number) =>
        n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
        subject: `🧾 Invoice received — ${wo.title} · ${invoice.invoice_number}`,
        html: await renderPmAlert({
          heading:  'Invoice ready for payment',
          body:     `${vendor?.name ?? 'Your vendor'} has completed ${wo.title} and submitted an invoice.`,
          details: [
            { label: 'Property',       value: property?.name ?? null },
            { label: 'Invoice Number', value: invoice.invoice_number },
            { label: 'Amount Due',     value: fmt(invoice.total) },
          ],
          ctaLabel: 'Review & Pay Invoice →',
          ctaUrl:   invoiceUrl,
        }),
      })
    })

    return { work_order_id, invoice_id, notified: true }
  }
)
