'use server'

import { requireOrgMember } from '@/lib/auth'
import { revalidatePath } from 'next/cache'

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
  const { supabase, membership } = await requireOrgMember()

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
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('work_order_line_items')
    .delete()
    .eq('id', lineItemId)
    .eq('org_id', membership.org_id)  // RLS reinforcement

  if (error) {
    console.error('[deleteWorkOrderLineItem]', error)
    throw new Error('Failed to delete line item')
  }
  revalidatePath('/maintenance')
}

export async function reorderWorkOrderLineItems(
  updates: Array<{ id: string; sort_order: number }>
) {
  const { supabase, membership } = await requireOrgMember()

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
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('work_orders')
    .update({
      vendor_acknowledged_at: new Date().toISOString(),
      vendor_acknowledged_by: (await supabase.auth.getUser()).data.user?.id,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) throw new Error(`Failed to mark acknowledged: ${error.message}`)
  revalidatePath('/maintenance')
}

export async function markWorkVerified(workOrderId: string) {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('work_orders')
    .update({
      completion_verified_at: new Date().toISOString(),
      completion_verified_by: (await supabase.auth.getUser()).data.user?.id,
      status:                 'completed',
      completed_date:         new Date().toISOString().split('T')[0],
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) throw new Error(`Failed to verify completion: ${error.message}`)
  revalidatePath('/maintenance')
}

// ── Access Instructions ───────────────────────────────────────

export async function updatePropertyAccessInstructions(
  propertyId: string,
  instructions: string
) {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('properties')
    .update({ access_instructions: instructions })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  if (error) throw new Error(`Failed to update access instructions: ${error.message}`)
  revalidatePath('/maintenance')
  revalidatePath('/properties')
}
