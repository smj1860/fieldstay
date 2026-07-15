import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'

/**
 * Helpers for POST /api/work-orders/[token]/complete — extracted out of
 * route.ts so the handler itself reads as: validate → claim → create
 * invoice → dispatch events, rather than all four concerns inline in one
 * 245-line function.
 */

export interface ClaimedWorkOrder {
  id:                 string
  org_id:             string
  vendor_id:          string | null
  property_id:        string
  wo_number:          string | null
  source_turnover_id: string | null
}

export interface SafeLineItem {
  line_type:   string
  description: string
  quantity:    number
  unit_cost:   number
  line_total:  number
}

export type CreateInvoiceResult =
  | { ok: true; invoiceId: string | null }
  | { ok: false; error: string }

/**
 * Inserts vendor-submitted line items and, if any were submitted and a
 * vendor is assigned, creates the invoice record (race-safe invoice
 * numbering via an atomic Postgres sequence, with an upsert-conflict
 * fallback that fetches the existing invoice rather than ever creating a
 * second one for the same work order).
 */
export async function createVendorInvoice(
  supabase:      SupabaseClient,
  claimed:       ClaimedWorkOrder,
  safeLineItems: SafeLineItem[],
  subtotal:      number,
): Promise<CreateInvoiceResult> {
  // Insert vendor-submitted line items
  if (safeLineItems.length > 0) {
    await supabase.from('work_order_line_items').insert(
      safeLineItems.map((item, idx) => ({
        work_order_id:    claimed.id,
        org_id:           claimed.org_id,
        line_type:        item.line_type,
        description:      item.description.trim(),
        quantity:         item.quantity,
        unit_cost:        item.unit_cost,
        line_total:       Math.round(item.unit_cost * item.quantity * 100) / 100,
        sort_order:       idx,
        vendor_submitted: true,
      }))
    )
  }

  if (safeLineItems.length === 0 || !claimed.vendor_id) {
    return { ok: true, invoiceId: null }
  }

  // Generate invoice number: INV-YYYY-NNNNN via an atomic Postgres sequence.
  // COUNT-then-INSERT is a TOCTOU race under concurrent submissions.
  const { data: seqResult, error: seqErr } = await supabase
    .rpc('next_work_order_invoice_seq')

  if (seqErr || seqResult == null) {
    console.error('[complete] invoice sequence error:', seqErr)
    return { ok: false, error: 'Invoice numbering failed. Please try again.' }
  }

  const invoiceNumber = `INV-${new Date().getFullYear()}-${String(seqResult).padStart(5, '0')}`

  const platformFeePct = parseFloat(process.env.STRIPE_PLATFORM_FEE_PCT ?? '0') / 100
  const platformFee    = Math.round(subtotal * platformFeePct * 100) / 100

  const { data: invoice } = await supabase
    .from('work_order_invoices')
    .upsert(
      {
        org_id:              claimed.org_id,
        work_order_id:       claimed.id,
        vendor_id:           claimed.vendor_id,
        property_id:         claimed.property_id,
        invoice_number:      invoiceNumber,
        status:              'pending_payment',
        subtotal,
        total:               subtotal,
        platform_fee_amount: platformFee,
      },
      { onConflict: 'work_order_id', ignoreDuplicates: true }
    )
    .select('id')
    .single()

  if (invoice) {
    await logAuditEvent({
      orgId:      claimed.org_id,
      action:     'work_order.invoice.created',
      targetType: 'work_order_invoice',
      targetId:   invoice.id,
      metadata:   { work_order_id: claimed.id, vendor_id: claimed.vendor_id, invoice_number: invoiceNumber, amount: subtotal },
      // No actorId — unauthenticated vendor-token route
    })
    return { ok: true, invoiceId: invoice.id }
  }

  // UNIQUE(work_order_id) conflict — ignoreDuplicates means the upsert
  // inserted nothing, so fetch the existing invoice instead of dropping
  // the reference (never create a second invoice for the same WO).
  const { data: existing } = await supabase
    .from('work_order_invoices')
    .select('id')
    .eq('work_order_id', claimed.id)
    .single()

  return { ok: true, invoiceId: existing?.id ?? null }
}

/**
 * Fires the completion Inngest event (invoice-submitted vs. the legacy
 * completed-via-portal path) and, if this work order is linked to a
 * turnover that isn't already closed, cascades the turnover-completion
 * event too.
 */
export async function dispatchCompletionEvents(
  supabase:  SupabaseClient,
  claimed:   ClaimedWorkOrder,
  invoiceId: string | null,
  token:     string,
  notes:     string | null,
  subtotal:  number,
): Promise<void> {
  if (invoiceId) {
    await inngest.send({
      name: 'work-order/invoice-submitted',
      data: {
        work_order_id: claimed.id,
        invoice_id:    invoiceId,
        org_id:        claimed.org_id,
        vendor_id:     claimed.vendor_id!,
        property_id:   claimed.property_id,
        total:         subtotal,
      },
    })
  } else {
    // Legacy path (no line items) — existing portal completion event
    await inngest.send({
      name: 'work-order/completed-via-portal',
      data: {
        work_order_id:    claimed.id,
        completion_token: token,
        notes:            notes ?? null,
        photo_paths:      [],
      },
    })
  }

  // Fire turnover completion automation if this WO is linked to a turnover
  if (claimed.source_turnover_id) {
    const { data: turnover } = await supabase
      .from('turnovers')
      .select('id, property_id, org_id, status')
      .eq('id', claimed.source_turnover_id)
      .single()

    if (turnover && !['completed', 'cancelled'].includes(turnover.status)) {
      await inngest.send({
        name: 'turnover/completed',
        data: {
          turnover_id:          turnover.id,
          property_id:          turnover.property_id,
          org_id:               turnover.org_id,
          completed_by_crew_id: '',
          completed_at:         new Date().toISOString(),
        },
      })
    }
  }
}
