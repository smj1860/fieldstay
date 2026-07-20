'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import type { InventoryCategory } from '@/types/database'

export interface CatalogItemInput {
  name:         string
  category:     InventoryCategory
  default_unit: string
  description:  string
  is_active:    boolean
}

export async function createCatalogItem(
  input: CatalogItemInput
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const name = input.name.trim()
    if (!name) return { error: 'Item name is required.' }
    const defaultUnit = input.default_unit.trim() || 'units'

    const { data, error } = await supabase
      .from('inventory_catalog')
      .insert({
        name,
        category:     input.category,
        default_unit: defaultUnit,
        description:  input.description.trim() || null,
        is_active:    input.is_active,
      })
      .select('id')
      .single()

    if (error || !data) {
      console.error('[createCatalogItem]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_catalog_item.created',
      targetType: 'inventory_catalog',
      targetId:   data.id,
      metadata:   { name, category: input.category },
    })

    revalidatePath('/admin/inventory-catalog')
    return { id: data.id }
  } catch (err) {
    console.error('[createCatalogItem]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function updateCatalogItem(
  itemId: string,
  input:  CatalogItemInput
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const name = input.name.trim()
    if (!name) return { error: 'Item name is required.' }
    const defaultUnit = input.default_unit.trim() || 'units'

    const { data, error } = await supabase
      .from('inventory_catalog')
      .update({
        name,
        category:     input.category,
        default_unit: defaultUnit,
        description:  input.description.trim() || null,
        is_active:    input.is_active,
      })
      .eq('id', itemId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[updateCatalogItem]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Catalog item not found.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_catalog_item.updated',
      targetType: 'inventory_catalog',
      targetId:   itemId,
      metadata:   { name, category: input.category, is_active: input.is_active },
    })

    revalidatePath('/admin/inventory-catalog')
    return {}
  } catch (err) {
    console.error('[updateCatalogItem]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteCatalogItem(
  itemId: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data, error } = await supabase
      .from('inventory_catalog')
      .delete()
      .eq('id', itemId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[deleteCatalogItem]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Catalog item not found.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_catalog_item.deleted',
      targetType: 'inventory_catalog',
      targetId:   itemId,
    })

    revalidatePath('/admin/inventory-catalog')
    return {}
  } catch (err) {
    console.error('[deleteCatalogItem]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}
