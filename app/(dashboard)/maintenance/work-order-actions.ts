'use server'

import { requireOrgRole } from '@/lib/auth'
import { reportError } from '@/lib/observability/report-error'
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

  const { error } = await supabase
    .from('work_order_line_items')
    .insert({
      work_order_id: workOrderId,
      org_id:        membership.org_id,
      ...item,
    })

  if (error) {
    console.error('[addWorkOrderLineItem]', error)
    throw new Error('Failed to add line item')
  }
  revalidatePath('/maintenance')
}

export async function deleteWorkOrderLineItem(lineItemId: string) {
  const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

  const { data: lineItem } = await supabase
    .from('work_order_line_items')
    .select('work_order_id')
    .eq('id', lineItemId)
    .eq('org_id', membership.org_id)
    .single()

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

export async function reorderWorkOrderLineItems(
  updates: Array<{ id: string; sort_order: number }>
) {
  const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

  const promises = updates.map(({ id, sort_order }) =>
    supabase
      .from('work_order_line_items')
      .update({ sort_order })
      .eq('id', id)
      .eq('org_id', membership.org_id)
  )

  const results = await Promise.all(promises)
  const failed = results.find(({ error }) => error)
  if (failed?.error) throw new Error(`Failed to reorder: ${failed.error.message}`)
  revalidatePath('/maintenance')
}

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
