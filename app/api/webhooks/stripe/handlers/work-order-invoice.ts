import type Stripe from 'stripe'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import type { StripeSupabaseClient } from './types'

/**
 * A vendor's work-order invoice was paid via a Stripe Checkout session
 * (session.metadata.invoice_id + org_id identify it). Posts the expense to
 * owner_transactions, backfills work_orders.actual_cost, and fires the
 * invoice-paid event — all idempotent, safe to run twice on webhook retry.
 */
export async function handleWorkOrderInvoicePaid(
  supabase: StripeSupabaseClient,
  session: Stripe.Checkout.Session,
  invoiceId: string,
  orgId: string,
): Promise<void> {
  // Idempotent update — safe to run twice
  const { data: inv } = await supabase
    .from('work_order_invoices')
    .update({
      status:                   'paid',
      stripe_payment_intent_id: typeof session.payment_intent === 'string'
        ? session.payment_intent
        : null,
      paid_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .eq('org_id', orgId)
    .eq('status', 'pending_payment')  // only update if still pending (idempotent)
    .select('id, work_order_id, vendor_id, property_id, total')
    .single()

  if (!inv) return

  // Post expense to owner_transactions
  // source_reference_id dedup prevents double-posting on retry
  await supabase.from('owner_transactions').upsert(
    {
      org_id:               orgId,
      property_id:          inv.property_id,
      work_order_id:        inv.work_order_id,
      source:               'wo_completion',
      source_reference_id:  inv.work_order_id,
      transaction_type:     'expense',
      category:             'maintenance',
      amount:               inv.total,
      description:          `Work order invoice paid`,
      transaction_date:     new Date().toISOString().split('T')[0],
      visible_to_owner:     false,
    },
    { onConflict: 'source_reference_id,source', ignoreDuplicates: true }
  )

  // Update work order actual_cost
  await supabase
    .from('work_orders')
    .update({ actual_cost: inv.total })
    .eq('id', inv.work_order_id)
    .is('actual_cost', null)  // don't overwrite if PM already logged it

  // Fire audit event via Inngest (non-blocking)
  await inngest.send({
    name: 'work-order/invoice-paid',
    data: {
      work_order_id: inv.work_order_id,
      invoice_id:    inv.id,
      org_id:        orgId,
      property_id:   inv.property_id,
      amount_paid:   inv.total,
    },
  })

  await logAuditEvent({
    orgId,
    action:     'work_order.invoice.paid',
    targetType: 'work_order_invoice',
    targetId:   inv.id,
    metadata:   { amount: inv.total },
    // No Stripe session ID or payment intent ID — financial PII rule
  })
}
