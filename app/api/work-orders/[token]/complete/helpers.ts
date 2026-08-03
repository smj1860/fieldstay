import { unwrap, tryUnwrap } from '@/lib/supabase/unwrap'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { advanceSchedulesAfterCompletion } from '@/app/(dashboard)/maintenance/complete-work-order-helpers'

/**
 * Helpers for POST /api/work-orders/[token]/complete.
 *
 * Every DATABASE write for a completion now lives in the
 * complete_work_order_via_token() RPC (migration 20260801200000), so what
 * remains here is only the side effects that must NOT be inside that
 * transaction: the audit log and Inngest dispatch. Both are non-transactional
 * by nature — an event fired from inside a transaction that later aborts
 * cannot be unfired.
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
}

/**
 * What complete_work_order_via_token() returns. Every database write for a
 * completion now happens inside that one function, so this file no longer
 * creates the invoice, inserts line items, or compensates a lost claim —
 * a rolled-back transaction leaves nothing to compensate for.
 */
export type CompletionResult =
  | { claimed: false; reason: 'not_found' | 'already_closed' }
  | {
      claimed:          true
      previous_status:  string
      work_order:       ClaimedWorkOrder
      invoice_id:       string | null
      /** Non-null only when THIS request minted the number. */
      invoice_number:   string | null
      /** True only when THIS request inserted the invoice row. */
      invoice_inserted: boolean
    }

/**
 * Everything that must happen once — and only once — the completion claim has
 * actually been won. Kept together here rather than inline in the route so the
 * handler itself stays readable as: validate → invoice → claim → finalize.
 */
export async function finalizeVendorCompletion(
  supabase: SupabaseClient,
  input: {
    claimed:         ClaimedWorkOrder
    invoiceId:       string | null
    invoiceNumber:   string | null
    invoiceInserted: boolean
    subtotal:        number
    notes:           string | null
    token:           string
  },
): Promise<void> {
  const { claimed, invoiceId, invoiceNumber, invoiceInserted, subtotal, notes, token } = input

  // Audit only for an invoice this request actually minted — a replay that
  // reused an existing invoice must not log a second "created" event.
  if (invoiceInserted && invoiceId && invoiceNumber) {
    await logVendorInvoiceCreated(claimed, invoiceId, invoiceNumber, subtotal)
  }

  await dispatchCompletionEvents(supabase, claimed, invoiceId, token, notes, subtotal)
}

/**
 * Audit trail for an invoice that actually stuck. Gated on invoice_inserted
 * from the RPC, so a replay that reused an existing invoice does not log a
 * second "created" event for the same row.
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

  // Advance the source maintenance schedule, if this WO came from one.
  //
  // The vendor portal was a completion path that never did this: next_due_date
  // stayed put, so the nightly cron kept seeing the schedule as due, kept
  // colliding with wo_maintenance_schedule_date_unique, and kept treating the
  // 23505 as an expected lost race — the schedule silently stopped recurring.
  //
  // Read here rather than returned from complete_work_order_via_token(),
  // because widening that function's return shape needs a migration and the
  // local/live migration ledgers are currently out of sync. Two columns on one
  // already-claimed row; cheap, and it keeps this fix migration-free.
  const scheduleRes = await supabase
    .from('work_orders')
    .select('source_schedule_id, source')
    .eq('id', claimed.id)
    .eq('org_id', claimed.org_id)
    .maybeSingle()

  const scheduleOut = tryUnwrap<{ source_schedule_id: string | null; source: string | null }>(
    scheduleRes, { site: 'api.work-orders.complete.source-schedule', orgId: claimed.org_id },
  )
  const scheduleRow = scheduleOut.ok ? scheduleOut.data : null

  if (scheduleRow?.source_schedule_id) {
    await advanceSchedulesAfterCompletion(supabase, claimed.org_id, [{
      scheduleId:      scheduleRow.source_schedule_id,
      workOrderSource: scheduleRow.source,
    }])
  }

  // Fire turnover completion automation if this WO is linked to a turnover
  if (claimed.source_turnover_id) {
    // Discarding this error left `turnover` null, which skips the
    // turnover/completed event below — so the linked turnover never completed
    // and its downstream side effects (owner_transactions, notifications)
    // never fired, with nothing recorded.
    const turnoverRes = await supabase
      .from('turnovers')
      .select('id, property_id, org_id, status')
      .eq('id', claimed.source_turnover_id)
      .maybeSingle()

    const turnover = unwrap(turnoverRes, { site: 'api.work-orders.complete.source-turnover' })

    if (turnover && !['completed', 'cancelled'].includes(turnover.status)) {
      const completedAt = new Date().toISOString()

      // CLAIM the turnover, don't just read it. The read above proved the
      // status at the time of the read; only the UPDATE's own WHERE clause
      // proves this caller is the one closing it.
      //
      // Previously this fired turnover/completed while never writing
      // turnovers.status at all, so: the cleaning fee posted and the PM was
      // told "✓ Turnover complete", while the turnover stayed in_progress on
      // the board. When someone later completed it for real, the
      // .neq('status','completed') guard on that path passed — it was still
      // in_progress — and the event fired a SECOND time. The owner_transactions
      // upsert absorbed the duplicate, but fieldstay_turnovers_completed_total
      // counted twice and completed_at landed hours after the fee, corrupting
      // the duration that assignment_outcomes and crew scoring derive from it.
      const claimRes = await supabase
        .from('turnovers')
        .update({ status: 'completed', completed_at: completedAt })
        .eq('id', turnover.id)
        .not('status', 'in', '("completed","cancelled")')
        .select('id')
        .maybeSingle()

      const claimOut = tryUnwrap<{ id: string }>(claimRes, {
        site:  'api.work-orders.complete.claim-turnover',
        orgId: claimed.org_id,
      })

      if (!claimOut.ok) {
        // Do NOT fall through to the event: firing it after a failed claim
        // reintroduces exactly the fee-posted-but-turnover-open state.
        console.error('[work-order-complete] turnover claim failed', { turnoverId: turnover.id })
        return
      }

      // Zero rows means another path completed it between the read and the
      // update — that path fires its own event, so this one must not.
      if (!claimOut.data) return

      await inngest.send({
        name: 'turnover/completed',
        data: {
          turnover_id:          turnover.id,
          property_id:          turnover.property_id,
          org_id:               turnover.org_id,
          completed_by_crew_id: '',
          completed_at:         completedAt,
        },
      })
    }
  }
}
