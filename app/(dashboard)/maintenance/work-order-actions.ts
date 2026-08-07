'use server'

import { requireOrgRole } from '@/lib/auth'
import { reportError } from '@/lib/observability/report-error'
import { isRealQueryError } from '@/lib/supabase/unwrap'
import { revalidatePath } from 'next/cache'
import { logAuditEvent } from '@/lib/audit'
import type { WoStatus } from '@/types/database'
import {
  COMPLETED_WORK_ORDER_SELECT,
  finalizeWorkOrderCompletion,
  workOrderCompletionFields,
  type CompletedWorkOrderRow,
} from './complete-work-order-helpers'

// ── Line Items ────────────────────────────────────────────────

/**
 * The next sort_order for a work order's line items.
 *
 * sort_order decides the order line items print in — on the work-order detail
 * page, on the board, and on the invoice at /invoices/[invoiceId], all three
 * of which read them back with `.order('sort_order')`. This used to default to
 * a flat 0, and the only UI that adds a line item never passed one, so every
 * PM-entered line on a work order carried the SAME sort key. Sorting rows that
 * all tie leaves the order up to Postgres, which is free to return a different
 * one on a different run — so an invoice going to a vendor and feeding an
 * owner statement could shuffle its own lines between loads.
 *
 * The quote-approval path already got this right: approve_quote_request offsets
 * the copied lines past whatever the work order holds, with a comment saying
 * two items would otherwise both claim 0. This is the same rule for the
 * hand-entry path.
 *
 * MAX+1 is read-then-write, so two simultaneous adds can land on the same
 * number. That is deliberately not guarded: a collision costs a tie between
 * exactly two rows, which the created_at/id tiebreakers on every read already
 * resolve deterministically. A sequence or an advisory lock would be real
 * machinery for a cosmetic outcome.
 */
async function nextLineItemSortOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client is untyped repo-wide (no <Database> generic; see lib/supabase/server.ts)
  supabase: any,
  workOrderId: string,
  orgId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('work_order_line_items')
    .select('sort_order')
    .eq('work_order_id', workOrderId)
    .eq('org_id', orgId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()

  // A failed read must not silently reintroduce the flat-0 default it exists
  // to remove — but it also must not block adding the line. Reported, then
  // fall back to 0, where the tiebreakers still give a stable order.
  if (error) {
    reportError(error, { site: 'maintenance.addWorkOrderLineItem.sortOrder', orgId })
    return 0
  }
  return typeof data?.sort_order === 'number' ? data.sort_order + 1 : 0
}

export async function addWorkOrderLineItem(
  workOrderId: string,
  item: {
    line_type: 'labor' | 'material' | 'equipment' | 'subcontractor' | 'other'
    description: string
    quantity: number
    unit: string | null
    unit_cost: number
    sort_order?: number
  }
) {
  const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

  const sortOrder = item.sort_order ?? await nextLineItemSortOrder(supabase, workOrderId, membership.org_id)

  const { error } = await supabase
    .from('work_order_line_items')
    // Explicit field list, NOT `...item`. The spread came last, so a client
    // could override org_id and work_order_id — the two fields that scope this
    // row — and could also inject `line_total`, which is GENERATED ALWAYS and
    // makes Postgres reject the entire statement with 428C9. The parameter type
    // is compile-time only; it validates nothing at runtime.
    .insert({
      work_order_id: workOrderId,
      org_id:        membership.org_id,
      line_type:     item.line_type,
      description:   item.description,
      quantity:      item.quantity,
      unit:          item.unit,
      unit_cost:     item.unit_cost,
      sort_order:    sortOrder,
    })

  if (error) {
    console.error('[addWorkOrderLineItem]', error)
    throw new Error('Failed to add line item')
  }
  revalidatePath('/maintenance')
}

export async function deleteWorkOrderLineItem(lineItemId: string) {
  const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

  const { data: lineItem, error: lineItemError } = await supabase
    .from('work_order_line_items')
    .select('work_order_id')
    .eq('id', lineItemId)
    .eq('org_id', membership.org_id)
    .single()

  if (isRealQueryError(lineItemError)) {
    reportError(lineItemError, { site: 'maintenance.deleteWorkOrderLineItem.lookup', orgId: membership.org_id })
  }

  const { error } = await supabase
    .from('work_order_line_items')
    .delete()
    .eq('id', lineItemId)
    .eq('org_id', membership.org_id)  // RLS reinforcement

  if (error) {
    console.error('[deleteWorkOrderLineItem]', error)
    throw new Error('Failed to delete line item')
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'work_order.updated',
    targetType: 'work_order',
    targetId:   lineItem?.work_order_id,
    metadata:   { change: 'line_item_deleted', line_item_id: lineItemId },
  })

  revalidatePath('/maintenance')
}

// reorderWorkOrderLineItems was deleted here 2026-08-06. It took a list of
// {id, sort_order} pairs — the shape a drag-and-drop control sends after a drop
// shifts everything below it — and it had no caller, because that drag handle
// was never built: line-items-editor.tsx adds a line and deletes a line, and
// that is the whole editor.
//
// The idea behind it was sound (arrange the lines the way the invoice should
// read, rather than the order they were typed), but its absence was not the
// real problem. The real problem was that sort_order had no meaningful value
// to reorder: every hand-entered line defaulted to 0, so the three reads that
// `.order('sort_order')` were sorting an all-ties column. That is fixed at the
// source — see nextLineItemSortOrder above, and the created_at/id tiebreakers
// on each read. If hand-arranging is ever wanted, it gets built against a
// column that now means something.

// ── Sign-Off ──────────────────────────────────────────────────

export async function markVendorAcknowledged(workOrderId: string) {
  const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

  const { error } = await supabase
    .from('work_orders')
    .update({
      vendor_acknowledged_at: new Date().toISOString(),
      vendor_acknowledged_by: user.id,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) throw new Error(`Failed to mark acknowledged: ${error.message}`)

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'work_order.updated',
    targetType: 'work_order',
    targetId:   workOrderId,
    metadata:   { change: 'vendor_acknowledged' },
  })

  revalidatePath('/maintenance')
}

export async function markWorkVerified(workOrderId: string) {
  const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

  const { data: wo, error: woError } = await supabase
    .from('work_orders')
    .select('vendor_id, status')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  // A query error is NOT "not found". Collapsing the two told the PM the work
  // order does not exist when the database was simply unreachable — and the
  // vendor-assignment guard immediately below depends on this row, so failing
  // to distinguish them risks reasoning from an absent record.
  if (woError) {
    console.error('[markWorkVerified] work order lookup failed', woError)
    reportError(woError, { site: 'maintenance.markWorkVerified.lookup', orgId: membership.org_id })
    throw new Error('Could not load the work order. Please try again.')
  }

  if (!wo) throw new Error('Work order not found')

  // Vendor-assigned work orders must be completed through the vendor's own
  // portal (with line items), which is what actually generates the invoice
  // and Stripe Connect payout — a PM manually verifying it here would mark
  // it complete with no invoice ever created and no path to pay the vendor.
  if (wo.vendor_id) {
    throw new Error(
      'This work order is assigned to a vendor. It must be completed through the vendor\'s ' +
      'portal so the invoice and Stripe payment can be generated — not marked complete here.'
    )
  }

  // This is the WO detail "verify" button — one of the three ways a PM
  // completes a work order. It used to write `status = 'completed'` and stop
  // there, never firing work-order/completed, so no maintenance expense was
  // posted to owner_transactions and the source schedule never advanced.
  // `.neq('status', 'completed')` claims the row so a double-click (or a race
  // with the bulk path) fans out exactly once.
  const { data: verified, error } = await supabase
    .from('work_orders')
    .update({
      ...workOrderCompletionFields(),
      completion_verified_at: new Date().toISOString(),
      completion_verified_by: user.id,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .neq('status', 'completed')
    .select(COMPLETED_WORK_ORDER_SELECT)
    .maybeSingle()

  if (error) throw new Error(`Failed to verify completion: ${error.message}`)

  if (verified) {
    await finalizeWorkOrderCompletion(
      supabase,
      membership.org_id,
      [verified as CompletedWorkOrderRow],
      {
        statusFromById:  new Map([[workOrderId, (wo.status ?? null) as WoStatus | null]]),
        updatedByUserId: user.id,
      },
    )
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'work_order.updated',
    targetType: 'work_order',
    targetId:   workOrderId,
    metadata:   { change: 'verified' },
  })

  revalidatePath('/maintenance')
}

// ── Access Instructions ───────────────────────────────────────

export async function updatePropertyAccessInstructions(
  propertyId: string,
  instructions: string
) {
  const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

  const { error } = await supabase
    .from('properties')
    .update({ access_instructions: instructions })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  if (error) throw new Error(`Failed to update access instructions: ${error.message}`)
  revalidatePath('/maintenance')
  revalidatePath('/properties')
}
