'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
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

  if (error) {
    console.error('[updateParLevel]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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
  if (error) {
    console.error('[addInventoryItems]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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

  if (countError || !count) {
    console.error('[submitInventoryCount]', countError)
    return { error: 'Failed to create inventory count. Please try again.' }
  }

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

    if (itemsError) {
      console.error('[submitInventoryCount] items insert', itemsError)
      return { error: 'Failed to record inventory count items. Please try again.' }
    }

    // Items that have never had a real count recorded get first_count_recorded_at
    // stamped now, so the "0 means uncounted, not critical" distinction holds going
    // forward. Supabase JS can't compare columns in an UPDATE, so check first.
    const { data: neverCountedRows } = await supabase
      .from('inventory_items')
      .select('id')
      .in('id', updates.map((u) => u.id))
      .is('first_count_recorded_at', null)
    const neverCountedIds = new Set((neverCountedRows ?? []).map((r) => r.id))

    // Update current_quantity on each item (org_id guard) — parallel to avoid serial timeout
    const now = new Date().toISOString()
    await Promise.all(
      updates.map((u) =>
        supabase
          .from('inventory_items')
          .update({
            current_quantity: u.current_quantity,
            ...(neverCountedIds.has(u.id) ? { first_count_recorded_at: now } : {}),
          })
          .eq('id', u.id)
          .eq('org_id', membership.org_id)
      )
    )
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

  // Upsert so concurrent calls don't race past the check+insert gap
  const { data: tmpl, error } = await supabase
    .from('inventory_templates')
    .upsert(
      { org_id: membership.org_id, name: 'Master Inventory List' },
      { onConflict: 'org_id', ignoreDuplicates: true }
    )
    .select('id, name')
    .single()

  if (error || !tmpl) {
    // Conflict ignored — fetch the existing row
    const { data: existing, error: fetchErr } = await supabase
      .from('inventory_templates')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .single()
    if (fetchErr || !existing) {
      console.error('[createOrGetTemplate]', fetchErr)
      return { error: 'Template not found' }
    }
    return { template: { ...existing, inventory_template_items: null } }
  }

  revalidatePath('/inventory')
  return { template: { ...tmpl, inventory_template_items: null } }
}

export async function addTemplateItem(
  templateId: string,
  item: { name: string; category: string; unit: string; par_level: number; preferred_brand?: string | null }
): Promise<{ item?: { id: string; name: string; category: string; unit: string; par_level: number; notes: null; preferred_brand: string | null }; error?: string }> {
  const { supabase } = await requireOrgMember()

  const { data, error } = await supabase
    .from('inventory_template_items')
    .insert({
      template_id:     templateId,
      name:            item.name,
      category:        item.category,
      unit:            item.unit,
      par_level:       item.par_level,
      preferred_brand: item.preferred_brand ?? null,
    })
    .select('id, name, category, unit, par_level, notes, preferred_brand')
    .single()

  if (error) {
    console.error('[addTemplateItem]', error)
    return { error: 'Operation failed. Please try again.' }
  }
  revalidatePath('/inventory')
  return { item: data! as { id: string; name: string; category: string; unit: string; par_level: number; notes: null; preferred_brand: string | null } }
}

export async function bulkAddTemplateItems(
  templateId: string,
  items: Array<{ name: string; category: string; unit: string; par_level: number; preferred_brand?: string | null }>
): Promise<{
  items?: Array<{ id: string; name: string; category: string; unit: string; par_level: number; notes: null; preferred_brand: string | null }>
  error?: string
}> {
  const { supabase } = await requireOrgMember()

  if (!items.length) return { items: [] }

  const { data, error } = await supabase
    .from('inventory_template_items')
    .insert(
      items.map((item) => ({
        template_id:     templateId,
        name:            item.name,
        category:        item.category,
        unit:            item.unit,
        par_level:       item.par_level,
        preferred_brand: item.preferred_brand ?? null,
      }))
    )
    .select('id, name, category, unit, par_level, notes, preferred_brand')

  if (error) {
    console.error('[bulkAddTemplateItems]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  revalidatePath('/inventory')
  return { items: data as Array<{ id: string; name: string; category: string; unit: string; par_level: number; notes: null; preferred_brand: string | null }> }
}

export async function updateTemplateItemBrand(
  itemId: string,
  brand:  string | null
): Promise<{ error?: string }> {
  const { supabase } = await requireOrgMember()

  const { error } = await supabase
    .from('inventory_template_items')
    .update({ preferred_brand: brand || null })
    .eq('id', itemId)

  if (error) {
    console.error('[updateTemplateItemBrand]', error)
    return { error: 'Operation failed. Please try again.' }
  }
  revalidatePath('/inventory')
  return {}
}

export async function removeTemplateItem(itemId: string): Promise<{ error?: string }> {
  const { supabase } = await requireOrgMember()

  const { error } = await supabase
    .from('inventory_template_items')
    .delete()
    .eq('id', itemId)

  if (error) {
    console.error('[removeTemplateItem]', error)
    return { error: 'Operation failed. Please try again.' }
  }
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

  const toInsert = templateItems
    .filter(item => !existingNames.has(item.name.toLowerCase()))
    .map(item => ({
      property_id:             propertyId,
      org_id:                  membership.org_id,
      name:                    item.name,
      category:                item.category,
      unit:                    item.unit,
      par_level:               item.par_level,
      current_quantity:        0,
      notes:                   item.notes,
      catalog_item_id:         item.catalog_item_id,
      is_active:               true,
      low_stock_threshold_pct: 20,
      preferred_brand:         (item as { preferred_brand?: string | null }).preferred_brand ?? null,
    }))

  if (toInsert.length > 0) {
    await supabase.from('inventory_items').insert(toInsert)
  }

  revalidatePath('/inventory')
  return { added: toInsert.length, skipped: templateItems.length - toInsert.length }
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
    if (itemsErr) console.error('[applyTemplateToProperties]', itemsErr)
    return { error: 'No items in template', applied: 0 }
  }

  // Fetch all existing items for ALL target properties in a single query, then group by property
  const { data: allExisting } = await supabase
    .from('inventory_items')
    .select('property_id, catalog_item_id, name')
    .eq('org_id', membership.org_id)
    .in('property_id', propertyIds)

  const existingByProperty: Record<string, { catalogIds: Set<string>; names: Set<string> }> = {}
  for (const row of allExisting ?? []) {
    if (!existingByProperty[row.property_id]) {
      existingByProperty[row.property_id] = { catalogIds: new Set(), names: new Set() }
    }
    if (row.catalog_item_id) existingByProperty[row.property_id]!.catalogIds.add(row.catalog_item_id)
    existingByProperty[row.property_id]!.names.add(row.name.toLowerCase())
  }

  let applied = 0
  const allToInsert: Array<{
    property_id:             string
    org_id:                  string
    catalog_item_id:         string | null
    name:                    string
    category:                string
    unit:                    string
    par_level:               number
    current_quantity:        number
    low_stock_threshold_pct: number
    is_active:               boolean
    preferred_brand:         string | null
  }> = []

  for (const propertyId of propertyIds) {
    const existing = existingByProperty[propertyId] ?? { catalogIds: new Set<string>(), names: new Set<string>() }

    const toInsert = items
      .filter((item) => {
        if (item.catalog_item_id && existing.catalogIds.has(item.catalog_item_id)) return false
        if (existing.names.has(item.name.toLowerCase())) return false
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
        preferred_brand:         (item as { preferred_brand?: string | null }).preferred_brand ?? null,
      }))

    allToInsert.push(...toInsert)
    applied += toInsert.length
  }

  if (allToInsert.length > 0) {
    await supabase.from('inventory_items').insert(allToInsert)
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
  if (error) {
    console.error('[bulkAddTemplateItemsFromCSV]', error)
    return { error: 'Operation failed. Please try again.', added: 0 }
  }

  revalidatePath('/inventory')
  return { added: toInsert.length }
}

// ── Count approval actions ────────────────────────────────────────────────────

export async function approveInventoryCount(draftId: string): Promise<{ error?: string }> {
  const { supabase, user } = await requireOrgMember()

  const { data: draftItems } = await supabase
    .from('inventory_count_draft_items')
    .select('item_id, counted_qty')
    .eq('draft_id', draftId)

  if (!draftItems) return { error: 'Draft not found' }

  const { data: neverCountedRows } = await supabase
    .from('inventory_items')
    .select('id')
    .in('id', draftItems.map((item) => item.item_id))
    .is('first_count_recorded_at', null)
  const neverCountedIds = new Set((neverCountedRows ?? []).map((r) => r.id))

  const now = new Date().toISOString()
  await Promise.all(
    draftItems.map(item =>
      supabase
        .from('inventory_items')
        .update({
          current_quantity: item.counted_qty,
          ...(neverCountedIds.has(item.item_id) ? { first_count_recorded_at: now } : {}),
        })
        .eq('id', item.item_id)
    )
  )

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

  // Supabase JS client can't compare two columns directly; fetch active items and filter in JS.
  // Limit to 2000 rows (well above any real org's inventory) to prevent unbounded scans.
  const { data: allItems, error } = await supabase
    .from('inventory_items')
    .select('name, unit, current_quantity, par_level, first_count_recorded_at, property_id, property:properties(name)')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .limit(2000)

  if (error) {
    console.error('[generateAggregatedPurchaseList]', error)
    return { items: [], error: 'Operation failed. Please try again.' }
  }

  const grouped: Record<string, AggregatedItem> = {}
  for (const item of allItems ?? []) {
    if (!item.first_count_recorded_at) continue
    if ((item.current_quantity ?? 0) > (item.par_level ?? 0)) continue

    const key = item.name.toLowerCase()
    if (!grouped[key]) {
      grouped[key] = { name: item.name, unit: item.unit, totalNeeded: 0, properties: [] }
    }
    const needed = Math.max(0, (item.par_level ?? 0) - (item.current_quantity ?? 0))
    grouped[key]!.totalNeeded += needed
    const pName = Array.isArray(item.property)
      ? (item.property[0] as { name: string } | undefined)?.name ?? '—'
      : (item.property as { name: string } | null)?.name ?? '—'
    grouped[key]!.properties.push({ name: pName, needed })
  }

  return { items: Object.values(grouped).sort((a, b) => a.name.localeCompare(b.name)) }
}

// ── Purchase Order Status ─────────────────────────────────────────────────────

export async function updatePurchaseOrderStatus(
  purchaseOrderId: string,
  status: 'sent' | 'acknowledged' | 'ordered' | 'received' | 'cancelled'
): Promise<{ error?: string }> {
  const { user, supabase, membership } = await requireOrgMember()

  const { data: po } = await supabase
    .from('purchase_orders')
    .select('id, property_id, total_estimated_cost, status')
    .eq('id', purchaseOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!po) return { error: 'Purchase order not found' }
  if (po.status === status) return {}

  const statusUpdate: Record<string, unknown> = { status }
  if (status === 'sent') statusUpdate.sent_at = new Date().toISOString()

  const { error } = await supabase
    .from('purchase_orders')
    .update(statusUpdate)
    .eq('id', purchaseOrderId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[updatePurchaseOrderStatus]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'purchase_order.status_changed',
    targetType: 'purchase_order',
    targetId:   purchaseOrderId,
    metadata:   { old_status: po.status, new_status: status },
  })

  if (status === 'ordered') {
    await inngest.send({
      name: 'purchase-order/approved',
      data: {
        purchase_order_id:    purchaseOrderId,
        property_id:          po.property_id,
        org_id:               membership.org_id,
        total_estimated_cost: po.total_estimated_cost,
      },
    })
  }

  revalidatePath('/inventory')
  return {}
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