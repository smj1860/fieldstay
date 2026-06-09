'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'

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

  const toUpdate = items.filter(i => !!i.id)
  const toInsert = items.filter(i => !i.id)

  // Parallel updates (each targets a different row by id)
  if (toUpdate.length > 0) {
    await Promise.all(
      toUpdate.map(item =>
        supabase
          .from('inventory_items')
          .update({
            name:            item.name,
            category:        item.category as never,
            unit:            item.unit,
            par_level:       item.par_level,
            notes:           item.notes ?? null,
            preferred_brand: item.preferred_brand ?? null,
          })
          .eq('id', item.id!)
          .eq('org_id', membership.org_id)
      )
    )
  }

  // Batch insert new items
  if (toInsert.length > 0) {
    await supabase.from('inventory_items').insert(
      toInsert.map(item => ({
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
      }))
    )
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
  redirect(`/properties/${propertyId}/setup/messages`)
}
