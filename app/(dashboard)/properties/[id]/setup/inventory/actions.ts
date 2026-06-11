'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { applyTemplateToProperty } from '@/app/(dashboard)/inventory/actions'

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
      if (error) return { error: `Failed to update "${item.name}": ${error.message}` }
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
      if (error) return { error: `Failed to add "${item.name}": ${error.message}` }
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
