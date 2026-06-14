'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { applyTemplateToProperty } from '@/app/(dashboard)/inventory/actions'
import { logAuditEvent } from '@/lib/audit'

export { applyTemplateToProperty }

export type InventoryState = { error?: string; success?: boolean }

export async function upsertInventoryItems(
  propertyId: string,
  items: Array<{
    id?: string
    catalog_item_id?: string | null
    name: string
    category: string
    unit: string
    par_level: number
    notes?: string | null
    preferred_brand?: string | null
  }>
): Promise<InventoryState> {
  const { supabase, membership } = await requireOrgMember()

  for (const item of items) {
    if (item.id) {
      const { error } = await supabase
        .from('inventory_items')
        .update({
          name:            item.name,
          category:        item.category as never,
          unit:            item.unit,
          par_level:       item.par_level,
          notes:           item.notes ?? null,
          preferred_brand: item.preferred_brand ?? null,
        })
        .eq('id', item.id)
        .eq('org_id', membership.org_id)
      if (error) {
        console.error('[upsertInventoryItems]', error)
        return { error: 'Operation failed. Please try again.' }
      }
    } else {
      const { error } = await supabase.from('inventory_items').insert({
        property_id:      propertyId,
        org_id:           membership.org_id,
        catalog_item_id:  item.catalog_item_id ?? null,
        name:             item.name,
        category:         item.category as never,
        unit:             item.unit,
        par_level:        item.par_level,
        current_quantity: 0,
        notes:            item.notes ?? null,
        preferred_brand:  item.preferred_brand ?? null,
      })
      if (error) {
        console.error('[upsertInventoryItems]', error)
        return { error: 'Operation failed. Please try again.' }
      }
    }
  }

  revalidatePath(`/properties/${propertyId}/setup/inventory`)
  return { success: true }
}

export async function deleteInventoryItem(itemId: string, propertyId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()
  await supabase
    .from('inventory_items')
    .delete()
    .eq('id', itemId)
    .eq('org_id', membership.org_id)
  revalidatePath(`/properties/${propertyId}/setup/inventory`)
}

export async function completeInventoryStep(propertyId: string): Promise<void> {
  await markStepComplete(propertyId, 'inventory')
  redirect(`/properties/${propertyId}/setup/checklist`)
}

export async function cloneInventoryFromProperty(
  sourcePropertyId: string,
  targetPropertyId: string,
): Promise<{ added: number; skipped: number; error?: string }> {
  const { supabase, membership, user } = await requireOrgMember()

  const { data: sourceItems } = await supabase
    .from('inventory_items')
    .select('name, category, unit, par_level, preferred_brand, catalog_item_id, low_stock_threshold_pct')
    .eq('property_id', sourcePropertyId)
    .eq('org_id', membership.org_id)
    .eq('is_active', true)

  if (!sourceItems?.length) return { added: 0, skipped: 0, error: 'Source property has no inventory items' }

  const { data: existing } = await supabase
    .from('inventory_items')
    .select('name')
    .eq('property_id', targetPropertyId)
    .eq('org_id', membership.org_id)
    .eq('is_active', true)

  const existingNames = new Set((existing ?? []).map(i => i.name.toLowerCase()))

  const toInsert = sourceItems
    .filter(item => !existingNames.has(item.name.toLowerCase()))
    .map(item => ({
      property_id:             targetPropertyId,
      org_id:                  membership.org_id,
      catalog_item_id:         item.catalog_item_id ?? null,
      name:                    item.name,
      category:                item.category as never,
      unit:                    item.unit,
      par_level:               item.par_level,
      current_quantity:        0,
      low_stock_threshold_pct: item.low_stock_threshold_pct ?? 20,
      preferred_brand:         item.preferred_brand ?? null,
      is_active:               true,
    }))

  const skipped = sourceItems.length - toInsert.length
  if (toInsert.length === 0) return { added: 0, skipped }

  const { error } = await supabase.from('inventory_items').insert(toInsert)
  if (error) {
    console.error('[cloneInventoryFromProperty]', error)
    return { added: 0, skipped, error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'property.inventory.cloned',
    targetType: 'property',
    targetId:   targetPropertyId,
    metadata:   { sourcePropertyId, added: toInsert.length, skipped },
  })

  revalidatePath(`/properties/${targetPropertyId}/setup/inventory`)
  return { added: toInsert.length, skipped }
}
