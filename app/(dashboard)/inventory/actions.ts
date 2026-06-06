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

// ── Add inventory items (bulk) ───────────────────────────────────────────────

export async function addInventoryItems(
  _prev: InventoryActionState | null,
  formData: FormData
): Promise<InventoryActionState> {
  const { supabase, membership } = await requireOrgMember()

  const property_id = formData.get('property_id') as string
  const itemCount   = parseInt(formData.get('item_count') as string, 10) || 0

  if (!property_id) return { error: 'Property is required' }
  if (itemCount === 0) return { error: 'Select at least one item' }

  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  const rows = []
  for (let i = 0; i < itemCount; i++) {
    const catalog_item_id = (formData.get(`item_${i}_catalog_item_id`) as string) || null
    const name     = (formData.get(`item_${i}_name`) as string)?.trim()
    const category = (formData.get(`item_${i}_category`) as InventoryCategory) || 'other'
    const unit     = (formData.get(`item_${i}_unit`) as string)?.trim()
    const par_level = parseFloat(formData.get(`item_${i}_par_level`) as string) || 1
    const notes    = (formData.get(`item_${i}_notes`) as string)?.trim() || null

    if (!name || !unit) continue

    rows.push({
      property_id,
      org_id:                 membership.org_id,
      catalog_item_id,
      name,
      category,
      unit,
      par_level,
      current_quantity:       0,
      low_stock_threshold_pct: 20,
      is_active:              true,
      notes,
    })
  }

  if (rows.length === 0) return { error: 'No valid items to add' }

  const { error } = await supabase.from('inventory_items').insert(rows)
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

// ── Template actions ──────────────────────────────────────────────────────────

export async function createOrGetTemplate(): Promise<{
  template?: { id: string; name: string; inventory_template_items: null }
  error?: string
}> {
  const { supabase, membership } = await requireOrgMember()

  const { data: existing } = await supabase
    .from('inventory_templates')
    .select('id, name, inventory_template_items(*)')
    .eq('org_id', membership.org_id)
    .limit(1)
    .single()

  if (existing) return { template: existing as unknown as { id: string; name: string; inventory_template_items: null } }

  const { data: created, error } = await supabase
    .from('inventory_templates')
    .insert({ org_id: membership.org_id, name: 'Master Inventory List' })
    .select('id, name')
    .single()

  if (error) return { error: error.message }
  revalidatePath('/inventory')
  return { template: { ...created!, inventory_template_items: null } }
}

export async function addTemplateItem(
  templateId: string,
  item: { name: string; category: string; unit: string; par_level: number }
): Promise<{ item?: { id: string; name: string; category: string; unit: string; par_level: number; notes: null }; error?: string }> {
  const { supabase } = await requireOrgMember()

  const { data, error } = await supabase
    .from('inventory_template_items')
    .insert({
      template_id: templateId,
      name:        item.name,
      category:    item.category,
      unit:        item.unit,
      par_level:   item.par_level,
    })
    .select('id, name, category, unit, par_level, notes')
    .single()

  if (error) return { error: error.message }
  revalidatePath('/inventory')
  return { item: data! as { id: string; name: string; category: string; unit: string; par_level: number; notes: null } }
}

export async function removeTemplateItem(itemId: string): Promise<{ error?: string }> {
  const { supabase } = await requireOrgMember()

  const { error } = await supabase
    .from('inventory_template_items')
    .delete()
    .eq('id', itemId)

  if (error) return { error: error.message }
  revalidatePath('/inventory')
  return {}
}

export async function applyTemplateToProperty(
  templateId: string,
  propertyId: string
): Promise<{ added: number; skipped: number; error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: templateItems } = await supabase
    .from('inventory_template_items')
    .select('*')
    .eq('template_id', templateId)

  if (!templateItems?.length) return { added: 0, skipped: 0 }

  const { data: existingItems } = await supabase
    .from('inventory_items')
    .select('name')
    .eq('property_id', propertyId)
    .eq('org_id', membership.org_id)

  const existingNames = new Set((existingItems ?? []).map(i => i.name.toLowerCase()))

  let added = 0, skipped = 0

  for (const item of templateItems) {
    if (existingNames.has(item.name.toLowerCase())) { skipped++; continue }
    await supabase.from('inventory_items').insert({
      property_id:      propertyId,
      org_id:           membership.org_id,
      name:             item.name,
      category:         item.category,
      unit:             item.unit,
      par_level:        item.par_level,
      current_quantity: 0,
      notes:            item.notes,
      catalog_item_id:  item.catalog_item_id,
      is_active:        true,
      low_stock_threshold_pct: 20,
    })
    added++
  }

  revalidatePath('/inventory')
  return { added, skipped }
}

export async function applyTemplateToProperties(
  templateId: string,
  propertyIds: string[]
): Promise<{ error?: string; applied: number }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: items, error: itemsErr } = await supabase
    .from('inventory_template_items')
    .select('*')
    .eq('template_id', templateId)

  if (itemsErr || !items?.length) {
    return { error: itemsErr?.message ?? 'No items in template', applied: 0 }
  }

  let applied = 0

  for (const propertyId of propertyIds) {
    const { data: existing } = await supabase
      .from('inventory_items')
      .select('catalog_item_id, name')
      .eq('property_id', propertyId)

    const existingCatalogIds = new Set(
      (existing ?? []).map((e) => e.catalog_item_id).filter(Boolean)
    )
    const existingNames = new Set(
      (existing ?? []).map((e) => e.name.toLowerCase())
    )

    const toInsert = items
      .filter((item) => {
        if (item.catalog_item_id && existingCatalogIds.has(item.catalog_item_id)) return false
        if (existingNames.has(item.name.toLowerCase())) return false
        return true
      })
      .map((item) => ({
        property_id:             propertyId,
        org_id:                  membership.org_id,
        catalog_item_id:         item.catalog_item_id ?? null,
        name:                    item.name,
        category:                item.category,
        unit:                    item.unit,
        par_level:               item.par_level,
        current_quantity:        0,
        low_stock_threshold_pct: 20,
        is_active:               true,
      }))

    if (toInsert.length > 0) {
      await supabase.from('inventory_items').insert(toInsert)
      applied += toInsert.length
    }
  }

  revalidatePath('/inventory')
  return { applied }
}

export async function bulkAddTemplateItemsFromCSV(
  templateId: string,
  rows: Array<{ name: string; category: string; unit: string; par_level: number }>
): Promise<{ error?: string; added: number }> {
  const { supabase } = await requireOrgMember()

  const toInsert = rows.map((row, i) => ({
    template_id: templateId,
    name:        row.name,
    category:    row.category,
    unit:        row.unit,
    par_level:   row.par_level,
    sort_order:  i,
  }))

  const { error } = await supabase.from('inventory_template_items').insert(toInsert)
  if (error) return { error: error.message, added: 0 }

  revalidatePath('/inventory')
  return { added: toInsert.length }
}

// ── Count approval actions ────────────────────────────────────────────────────

export async function approveInventoryCount(draftId: string): Promise<{ error?: string }> {
  const { supabase, user } = await requireOrgMember()

  const { data: draftItems } = await supabase
    .from('inventory_count_draft_items')
    .select('inventory_item_id, submitted_quantity')
    .eq('draft_id', draftId)

  if (!draftItems) return { error: 'Draft not found' }

  for (const item of draftItems) {
    await supabase
      .from('inventory_items')
      .update({ current_quantity: item.submitted_quantity })
      .eq('id', item.inventory_item_id)
  }

  await supabase
    .from('inventory_count_drafts')
    .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: user.id })
    .eq('id', draftId)

  revalidatePath('/inventory')
  return {}
}

export async function rejectInventoryCount(draftId: string): Promise<{ error?: string }> {
  const { supabase, user } = await requireOrgMember()

  await supabase
    .from('inventory_count_drafts')
    .update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: user.id })
    .eq('id', draftId)

  revalidatePath('/inventory')
  return {}
}

// ── Aggregated purchase list ──────────────────────────────────────────────────

export interface AggregatedItem {
  name: string
  unit: string
  totalNeeded: number
  properties: Array<{ name: string; needed: number }>
}

export async function generateAggregatedPurchaseList(): Promise<{ items: AggregatedItem[]; error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: items, error } = await supabase
    .from('inventory_items')
    .select('name, unit, current_quantity, par_level, property_id, properties(name)')
    .eq('org_id', membership.org_id)
    .filter('current_quantity', 'lte', 'par_level')

  if (error) return { items: [], error: error.message }

  const grouped: Record<string, AggregatedItem> = {}
  for (const item of items ?? []) {
    const key = item.name.toLowerCase()
    if (!grouped[key]) {
      grouped[key] = { name: item.name, unit: item.unit, totalNeeded: 0, properties: [] }
    }
    const needed = Math.max(0, item.par_level - item.current_quantity)
    grouped[key]!.totalNeeded += needed
    const pName = Array.isArray(item.properties)
      ? (item.properties[0] as { name: string } | undefined)?.name ?? '—'
      : (item.properties as { name: string } | null)?.name ?? '—'
    grouped[key]!.properties.push({ name: pName, needed })
  }

  return { items: Object.values(grouped).sort((a, b) => a.name.localeCompare(b.name)) }
}

// ── Shopping Cart ──────────────────────────────────────────────────

export async function triggerShoppingCart(
  propertyIds?: string[],
  modality: 'PICKUP' | 'DELIVERY' | 'IN_STORE' = 'PICKUP'
): Promise<{ success: boolean; error?: string }> {
  const { user, membership } = await requireOrgMember()

  try {
    await inngest.send({
      name: 'inventory/cart_requested',
      data: {
        org_id:       membership.org_id,
        requested_by: user.id,
        property_ids: propertyIds,
        modality,
      },
    })
    return { success: true }
  } catch (err) {
    console.error('[triggerShoppingCart]', err)
    return { success: false, error: 'Failed to start cart build. Try again.' }
  }
}