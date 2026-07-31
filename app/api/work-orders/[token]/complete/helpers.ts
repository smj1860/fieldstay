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

/**
 * Everything createVendorInvoice() needs. Deliberately NOT ClaimedWorkOrder:
 * the invoice is now created BEFORE the completion claim (see the ordering
 * note on createVendorInvoice), so the only work order shape available at
 * that point is the one read from the completion token.
 */
export type InvoiceTarget = Pick<ClaimedWorkOrder, 'id' | 'org_id' | 'vendor_id' | 'property_id'>

export type CreateInvoiceResult =
  | {
      ok:        true
      invoiceId: string | null
      /** The generated number, only when this request inserted the row. */
      invoiceNumber: string | null
      /**
       * True only when THIS request's upsert actually inserted the invoice
       * (rather than finding one an earlier attempt already created). It is
       * what makes the rollback below safe: a request that loses the
       * completion claim may only delete an invoice it created itself.
       */
      insertedByThisRequest: boolean
    }
  | { ok: false; error: string }

/**
 * Creates the invoice record for a vendor completion, if any line items were
 * submitted and a vendor is assigned. Race-safe invoice numbering via an
 * atomic Postgres sequence, with an upsert-conflict fallback that fetches the
 * existing invoice rather than ever creating a second one for the same work
 * order.
 *
 * ORDERING — this runs BEFORE the work order is claimed as completed, and it
 * must stay that way. `work_orders.status = 'completed'` is what every other
 * reader (the PM dashboard, owner P&L, the vendor's own outbox) treats as
 * "done and billed", so it has to be the LAST thing that becomes true.
 * Claiming first published a completed work order whose invoice did not exist
 * yet, and if the invoice step then failed the work order was permanently
 * completed with no invoice: every vendor retry could only ever get the
 * already-closed 409, so the money row was simply lost. Creating the invoice
 * first is safe to repeat — the upsert is keyed on the work order — while
 * claiming first is not recoverable at all.
 */
export async function createVendorInvoice(
  supabase:      SupabaseClient,
  target:        InvoiceTarget,
  safeLineItems: SafeLineItem[],
  subtotal:      number,
): Promise<CreateInvoiceResult> {
  if (safeLineItems.length === 0 || !target.vendor_id) {
    return { ok: true, invoiceId: null, invoiceNumber: null, insertedByThisRequest: false }
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
        org_id:              target.org_id,
        work_order_id:       target.id,
        vendor_id:           target.vendor_id,
        property_id:         target.property_id,
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
    return { ok: true, invoiceId: invoice.id, invoiceNumber, insertedByThisRequest: true }
  }

  // UNIQUE(work_order_id) conflict — ignoreDuplicates means the upsert
  // inserted nothing, so fetch the existing invoice instead of dropping
  // the reference (never create a second invoice for the same WO). This is
  // the ordinary path for a retried submission whose first attempt created
  // the invoice but died before it could claim the completion.
  const { data: existing } = await supabase
    .from('work_order_invoices')
    .select('id')
    .eq('work_order_id', target.id)
    .single()

  return { ok: true, invoiceId: existing?.id ?? null, invoiceNumber: null, insertedByThisRequest: false }
}

/**
 * Everything that must happen once — and only once — the completion claim has
 * actually been won. Kept together here rather than inline in the route so the
 * handler itself stays readable as: validate → invoice → claim → finalize.
 */
export async function finalizeVendorCompletion(
  supabase: SupabaseClient,
  input: {
    claimed:        ClaimedWorkOrder
    invoiceResult:  Extract<CreateInvoiceResult, { ok: true }>
    safeLineItems:  SafeLineItem[]
    subtotal:       number
    notes:          string | null
    token:          string
    previousStatus: string
  },
): Promise<void> {
  const { claimed, invoiceResult, safeLineItems, subtotal, notes, token, previousStatus } = input

  // Line items go in after the claim — the claim is the mutex that makes this
  // exactly-once, and these rows have no unique key to dedupe a replay against.
  await insertVendorLineItems(supabase, claimed, safeLineItems)

  if (invoiceResult.insertedByThisRequest && invoiceResult.invoiceId && invoiceResult.invoiceNumber) {
    await logVendorInvoiceCreated(claimed, invoiceResult.invoiceId, invoiceResult.invoiceNumber, subtotal)
  }

  await supabase.from('work_order_updates').insert({
    work_order_id:             claimed.id,
    org_id:                    claimed.org_id,
    updated_via_vendor_portal: true,
    status_from:               previousStatus,
    status_to:                 'completed',
    notes,
  })

  await dispatchCompletionEvents(supabase, claimed, invoiceResult.invoiceId, token, notes, subtotal)
}

/**
 * Undoes the invoice side of a completion that lost its claim — a no-op
 * unless this request is the one that inserted the row.
 */
export async function rollbackUnclaimedInvoice(
  supabase:      SupabaseClient,
  invoiceResult: Extract<CreateInvoiceResult, { ok: true }>,
): Promise<void> {
  if (!invoiceResult.insertedByThisRequest || !invoiceResult.invoiceId) return
  await rollbackVendorInvoice(supabase, invoiceResult.invoiceId)
}

/**
 * Compensating delete for an invoice this request created and then could not
 * attach to a completion, because another path closed the work order in the
 * window between the token lookup and the atomic claim. Only ever called with
 * an id the SAME request inserted (`insertedByThisRequest`), so it can never
 * remove an invoice that belongs to a completion that did land.
 */
export async function rollbackVendorInvoice(supabase: SupabaseClient, invoiceId: string): Promise<void> {
  const { error } = await supabase.from('work_order_invoices').delete().eq('id', invoiceId)
  if (error) {
    // Surfaced rather than swallowed: the leftover is a real, if rare,
    // orphan — an invoice with no completed work order behind it.
    console.error('[complete] failed to roll back orphaned invoice', invoiceId, error)
  }
}

/**
 * Audit trail for an invoice that actually stuck. Deliberately separate from
 * createVendorInvoice() and called only once the completion claim has been
 * won — logging it inside the insert would leave an audit row asserting an
 * invoice exists for every row the rollback above had to take back.
 */
export async function logVendorInvoiceCreated(
  claimed:       ClaimedWorkOrder,
  invoiceId:     string,
  invoiceNumber: string,
  subtotal:      number,
): Promise<void> {
  await logAuditEvent({
    orgId:      claimed.org_id,
    action:     'work_order.invoice.created',
    targetType: 'work_order_invoice',
    targetId:   invoiceId,
    metadata:   { work_order_id: claimed.id, vendor_id: claimed.vendor_id, invoice_number: invoiceNumber, amount: subtotal },
    // No actorId — unauthenticated vendor-token route
  })
}

/**
 * Vendor-submitted line items. Runs AFTER the completion claim, unlike the
 * invoice: the claim is the mutex, so exactly one request ever reaches this,
 * and these rows have no unique key of their own to dedupe a second insert
 * against.
 */
export async function insertVendorLineItems(
  supabase:      SupabaseClient,
  claimed:       ClaimedWorkOrder,
  safeLineItems: SafeLineItem[],
): Promise<void> {
  if (safeLineItems.length === 0) return

  const { error } = await supabase.from('work_order_line_items').insert(
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
  if (error) console.error('[complete] failed to insert vendor line items for', claimed.id, error)
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
