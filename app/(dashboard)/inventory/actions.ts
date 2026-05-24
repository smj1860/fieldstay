'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import type { InventoryCategory } from '@/types/database'

export type InventoryActionState = { error?: string; success?: boolean }

// ── Update par level ─────────────────────────────────────────────────────────

export async function updateParLevel(
  itemId: string,
  parLevel: number
): Promise<InventoryActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('inventory_items')
    .update({ par_level: parLevel })
    .eq('id', itemId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath('/inventory')
  return { success: true }
}

// ── Add custom inventory item ────────────────────────────────────────────────

export async function addInventoryItem(
  _prev: InventoryActionState | null,
  formData: FormData
): Promise<InventoryActionState> {
  const { supabase, membership } = await requireOrgMember()

  const property_id = formData.get('property_id') as string
  const name        = (formData.get('name') as string)?.trim()
  const category    = formData.get('category') as InventoryCategory
  const unit        = (formData.get('unit') as string)?.trim()
  const par_level   = parseInt(formData.get('par_level') as string, 10) || 1
  const notes       = (formData.get('notes') as string)?.trim() || null

  if (!property_id) return { error: 'Property is required' }
  if (!name)        return { error: 'Item name is required' }
  if (!unit)        return { error: 'Unit is required' }

  // Verify property belongs to org
  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  const { error } = await supabase.from('inventory_items').insert({
    property_id,
    org_id:           membership.org_id,
    catalog_item_id:  null,
    name,
    category,
    unit,
    par_level,
    current_quantity: 0,
    low_stock_threshold_pct: 20,
    is_active: true,
    notes,
  })

  if (error) return { error: error.message }

  revalidatePath('/inventory')
  return { success: true }
}

// ── Submit inventory count ────────────────────────────────────────────────────

export async function submitInventoryCount(
  _prev: InventoryActionState | null,
  formData: FormData
): Promise<InventoryActionState> {
  const { supabase, membership } = await requireOrgMember()

  const property_id = formData.get('property_id') as string
  const notes       = (formData.get('notes') as string)?.trim() || null

  if (!property_id) return { error: 'Property is required' }

  // Verify property belongs to org
  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  // Create the inventory_count record
  const { data: count, error: countError } = await supabase
    .from('inventory_counts')
    .insert({
      property_id,
      org_id:       membership.org_id,
      submitted_at: new Date().toISOString(),
      notes,
    })
    .select('id')
    .single()

  if (countError || !count) return { error: countError?.message ?? 'Failed to create count' }

  // Parse item_{itemId} fields from formData
  const countItems: Array<{ count_id: string; inventory_item_id: string; quantity_counted: number }> = []
  const updates: Array<{ id: string; current_quantity: number }> = []

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('item_')) continue
    const itemId = key.slice('item_'.length)
    const qty    = parseInt(value as string, 10)
    if (isNaN(qty) || qty < 0) continue

    countItems.push({
      count_id:           count.id,
      inventory_item_id:  itemId,
      quantity_counted:   qty,
    })
    updates.push({ id: itemId, current_quantity: qty })
  }

  if (countItems.length > 0) {
    const { error: itemsError } = await supabase
      .from('inventory_count_items')
      .insert(countItems)

    if (itemsError) return { error: itemsError.message }

    // Update current_quantity on each item (org_id guard)
    for (const u of updates) {
      await supabase
        .from('inventory_items')
        .update({ current_quantity: u.current_quantity })
        .eq('id', u.id)
        .eq('org_id', membership.org_id)
    }
  }

  // Fire Inngest event
  await inngest.send({
    name: 'inventory/count-submitted',
    data: {
      count_id:    count.id,
      property_id,
      org_id:      membership.org_id,
    },
  })

  revalidatePath('/inventory')
  return { success: true }
}
