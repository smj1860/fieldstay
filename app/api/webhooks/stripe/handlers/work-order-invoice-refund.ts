import { unwrap } from '@/lib/supabase/unwrap'
import type Stripe from 'stripe'
import { logAuditEvent } from '@/lib/audit'
import type { StripeSupabaseClient } from './types'

/**
 * A refund landed on a vendor invoice's payment intent — issued from the
 * Stripe dashboard with reverse_transfer + refund_application_fee (see
 * lib/stripe/platform-fee.ts's destination-charge comment for why both flags
 * are load-bearing: without them the platform eats the vendor's payout).
 * This is the FieldStay-side half: without it, the invoice keeps claiming
 * 'paid', the expense sits on the owner's P&L, and work_orders.actual_cost is
 * wrong, with nothing anywhere to say the money moved twice.
 *
 * charge.refunded fires on every refund against a charge — full or partial —
 * and reports `amount_refunded` as the CUMULATIVE total refunded so far, not
 * a delta. A second, larger partial refund resends the running total. Every
 * write in this function is therefore SET-to-the-reported-value, not
 * increment-by, and is safe to run twice on webhook retry with the identical
 * event.
 *
 * Looked up by stripe_payment_intent_id alone, not by charge/session
 * metadata — that column is only ever set by handleWorkOrderInvoicePaid in
 * work-order-invoice.ts, so a match here already proves the row went through
 * our own paid path, and the row itself is the source of truth for org_id
 * from there on (never trusted from the charge object).
 */
export async function handleWorkOrderInvoiceRefunded(
  supabase: StripeSupabaseClient,
  charge: Stripe.Charge,
): Promise<void> {
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null
  if (!paymentIntentId) return

  const invRes = await supabase
    .from('work_order_invoices')
    .select('id, org_id, work_order_id, vendor_id, property_id, total, status, amount_refunded')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle()

  const inv = unwrap(invRes, { site: 'webhook.stripe.work-order-invoice-refund.lookup' })
  if (!inv) return   // Not one of ours — e.g. a refund on a different product's charge

  const newAmountRefunded = charge.amount_refunded / 100

  // Out-of-order delivery guard. Stripe delivers at-least-once but does not
  // guarantee ORDER between two distinct events — a second, larger partial
  // refund's event could in principle arrive before a resend of the first,
  // smaller one. Only ever move the recorded total forward; a smaller
  // incoming value than what's already stored is stale, not a reversal.
  if (newAmountRefunded <= inv.amount_refunded) return

  // amount_captured is Stripe's own figure for what this charge actually
  // collected — compared against the surcharge-inclusive total the customer
  // was charged (invoice.total holds only the vendor's portion; see the
  // checkout route), so "fully refunded" is asked of Stripe's number, not
  // re-derived from ours and risking the two disagreeing by a rounding cent.
  const isFullRefund = charge.amount_refunded >= charge.amount_captured
  const newStatus     = isFullRefund ? 'refunded' : 'partially_refunded'

  const updateRes = await supabase
    .from('work_order_invoices')
    .update({
      status:          newStatus,
      amount_refunded: newAmountRefunded,
      refunded_at:     new Date().toISOString(),
    })
    .eq('id', inv.id)
    .eq('org_id', inv.org_id)
  unwrap(updateRes, {
    site:  'webhook.stripe.work-order-invoice-refund.mark-refunded',
    orgId: inv.org_id,
    extra: { work_order_id: inv.work_order_id },
  })

  // Compensating credit against the SAME category the original expense
  // posted to ('maintenance'), as a NEGATIVE expense rather than a positive
  // 'revenue' row — every consumer of this table (load-owner-portal-data.ts
  // and friends) sums `amount` additively within transaction_type, with no
  // support for netting across types. A same-category negative expense nets
  // correctly wherever the original expense is reported, including anything
  // grouped by category; a same-magnitude 'revenue' row would not net there
  // and would misrepresent unrelated revenue as having increased.
  //
  // UPSERT that OVERWRITES on conflict — deliberately NOT ignoreDuplicates,
  // unlike the original paid-expense upsert next to this one in
  // work-order-invoice.ts. That one must never change once posted; this one
  // MUST change, because amount_refunded is cumulative and a second partial
  // refund needs this row's amount to grow to match — ignoreDuplicates would
  // silently drop that second event's financial effect entirely. Keyed on a
  // DIFFERENT source value ('wo_invoice_refund' vs 'wo_completion') against
  // the same uq_owner_txn_source(source_reference_id, source) index, which is
  // what stops this from colliding with — or overwriting — the original
  // expense row for the same work order.
  const creditRes = await supabase.from('owner_transactions').upsert(
    {
      org_id:              inv.org_id,
      property_id:         inv.property_id,
      work_order_id:       inv.work_order_id,
      source:              'wo_invoice_refund',
      source_reference_id: inv.work_order_id,
      transaction_type:    'expense',
      category:            'maintenance',
      amount:              -newAmountRefunded,
      description:         'Work order invoice refund',
      transaction_date:    new Date().toISOString().split('T')[0],
      visible_to_owner:    false,
    },
    { onConflict: 'source_reference_id,source' },
  )
  unwrap(creditRes, {
    site:  'webhook.stripe.work-order-invoice-refund.post-credit',
    orgId: inv.org_id,
    extra: { work_order_id: inv.work_order_id },
  })

  // Only touch actual_cost if it still holds exactly what the ORIGINAL
  // payment wrote. Mirrors the paid handler's `.is('actual_cost', null)`
  // guard in spirit: that one refuses to overwrite a PM's own manual entry
  // with the paid amount; this one refuses to overwrite it with the refund
  // adjustment. A PM who has since edited actual_cost for their own reasons
  // keeps their number either way.
  const adjustedCost = Math.max(0, inv.total - newAmountRefunded)
  const actualCostRes = await supabase
    .from('work_orders')
    .update({ actual_cost: adjustedCost === 0 ? null : adjustedCost })
    .eq('id', inv.work_order_id)
    .eq('actual_cost', inv.total)
  unwrap(actualCostRes, {
    site:  'webhook.stripe.work-order-invoice-refund.actual-cost',
    orgId: inv.org_id,
    extra: { work_order_id: inv.work_order_id },
  })

  // No Inngest event fired here on purpose. work-order/invoice-paid exists
  // because this exact codebase already shipped the failure mode once: an
  // event emitted with zero subscribers, so a paid vendor got no
  // notification beyond their own bank statement. Firing a symmetrical
  // 'invoice-refunded' event now, with nothing listening for it yet, would be
  // knowingly repeating that. If a vendor-facing "your payment was reversed"
  // notice is wanted, add the event and its consumer together, the way
  // CLAUDE.md's Inngest rule already requires.

  await logAuditEvent({
    orgId:      inv.org_id,
    action:     'work_order.invoice.refunded',
    targetType: 'work_order_invoice',
    targetId:   inv.id,
    // No amount in metadata — same financial-specifics rule as the paid
    // handler. targetId points at the row, which now carries amount_refunded.
    metadata:   { currency: 'usd', full: isFullRefund },
  })
}
