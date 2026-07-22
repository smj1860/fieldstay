'use server'

import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
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
  try {
    const { supabase, membership } = await requireOrgMember()

    const { data: property } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (!property) return { error: 'Property not found' }

    const existingItems = items.filter((item) => item.id)
    const newItems      = items.filter((item) => !item.id)

    if (existingItems.length) {
      // Confirm every client-supplied id already belongs to this org before
      // upserting — RLS's WITH CHECK backstops this, but a client-supplied id
      // for another org's row should never even reach the upsert call.
      const { data: verifiedRows } = await supabase
        .from('inventory_items')
        .select('id')
        .in('id', existingItems.map((item) => item.id!))
        .eq('org_id', membership.org_id)
      const verifiedIds  = new Set((verifiedRows ?? []).map((r) => r.id))
      const verifiedItems = existingItems.filter((item) => verifiedIds.has(item.id!))

      if (verifiedItems.length !== existingItems.length) {
        console.error('[upsertInventoryItems] rejected items not owned by org', { propertyId })
      }

      if (verifiedItems.length) {
        const { error } = await supabase.from('inventory_items').upsert(
          verifiedItems.map((item) => ({
            id:              item.id,
            org_id:          membership.org_id,
            property_id:     propertyId,
            name:            item.name,
            category:        item.category as never,
            unit:            item.unit,
            par_level:       item.par_level,
            notes:           item.notes ?? null,
            preferred_brand: item.preferred_brand ?? null,
          })),
          { onConflict: 'id' }
        )
        if (error) {
          console.error('[upsertInventoryItems]', error)
          return { error: 'Operation failed. Please try again.' }
        }
      }
    }

    if (newItems.length) {
      const { error } = await supabase.from('inventory_items').insert(
        newItems.map((item) => ({
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
      if (error) {
        console.error('[upsertInventoryItems]', error)
        return { error: 'Operation failed. Please try again.' }
      }
    }

    revalidatePath(`/properties/${propertyId}/setup/inventory`)
    return { success: true }
  } catch (err) {
    console.error('[upsertInventoryItems]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteInventoryItem(itemId: string, propertyId: string): Promise<void> {
  try {
    const { user, supabase, membership } = await requireOrgMember()
    await supabase
      .from('inventory_items')
      .delete()
      .eq('id', itemId)
      .eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'inventory.item.deleted',
      targetType: 'inventory_item',
      targetId:   itemId,
      metadata:   { property_id: propertyId },
    })

    revalidatePath(`/properties/${propertyId}/setup/inventory`)
  } catch (err) {
    console.error('[deleteInventoryItem]', err)
    throw err
  }
}

export async function bulkDeleteInventoryItems(
  itemIds: string[],
  propertyId: string
): Promise<void> {
  try {
    if (!itemIds.length) return
    const { user, supabase, membership } = await requireOrgMember()
    await supabase
      .from('inventory_items')
      .delete()
      .in('id', itemIds)
      .eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'inventory.item.deleted',
      targetType: 'inventory_item',
      metadata:   { property_id: propertyId, deleted_ids: itemIds },
    })

    revalidatePath(`/properties/${propertyId}/setup/inventory`)
  } catch (err) {
    console.error('[bulkDeleteInventoryItems]', err)
    throw err
  }
}

export async function completeInventoryStep(propertyId: string): Promise<void> {
  try {
    await markStepComplete(propertyId, 'inventory')
    redirect(`/properties/${propertyId}/setup/checklist`)
  } catch (err) {
    unstable_rethrow(err)
    console.error('[completeInventoryStep]', err)
    throw err
  }
}

export async function cloneInventoryFromProperty(
  sourcePropertyId: string,
  targetPropertyId: string,
): Promise<{ added: number; skipped: number; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    // Both source and target must be confirmed to belong to this org before
    // reading from / writing to them — a client-supplied id is not proof of
    // ownership, and the source-items read below is scoped by org_id too but
    // that alone doesn't stop an unverified targetPropertyId from being
    // written into the insert further down.
    const { data: targetProperty } = await supabase
      .from('properties')
      .select('id')
      .eq('id', targetPropertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (!targetProperty) return { added: 0, skipped: 0, error: 'Target property not found' }

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
  } catch (err) {
    console.error('[cloneInventoryFromProperty]', err)
    return { added: 0, skipped: 0, error: 'Operation failed. Please try again.' }
  }
}
