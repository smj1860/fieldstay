'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import type { InventoryCategory } from '@/types/database'

import { reportError } from '@/lib/observability/report-error'
export interface CatalogItemInput {
  name:              string
  category:          InventoryCategory
  default_unit:      string
  default_par_level: number
  description:       string
  is_active:         boolean
}

// A non-finite or non-positive input (empty field, stray text) falls back to
// 1 rather than writing NaN/0/a negative number — matches the
// Number.isFinite(...) ? ... : 1 guard already used for CSV-imported par
// levels in templates/inventory/create/create-template-builder.tsx.
function normalizeParLevel(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

export async function createCatalogItem(
  input: CatalogItemInput
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const name = input.name.trim()
    if (!name) return { error: 'Item name is required.' }
    const defaultUnit = input.default_unit.trim() || 'units'
    const defaultParLevel = normalizeParLevel(input.default_par_level)

    const { data, error } = await supabase
      .from('inventory_catalog')
      .insert({
        name,
        category:          input.category,
        default_unit:      defaultUnit,
        default_par_level: defaultParLevel,
        description:       input.description.trim() || null,
        is_active:         input.is_active,
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
    reportError(err, { site: 'serverAction.admin.inventory-catalog.createCatalogItem' })
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
    const defaultParLevel = normalizeParLevel(input.default_par_level)

    const { data, error } = await supabase
      .from('inventory_catalog')
      .update({
        name,
        category:          input.category,
        default_unit:      defaultUnit,
        default_par_level: defaultParLevel,
        description:       input.description.trim() || null,
        is_active:         input.is_active,
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
    reportError(err, { site: 'serverAction.admin.inventory-catalog.updateCatalogItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export interface BulkImportCatalogRow {
  name:              string
  category:          InventoryCategory
  default_unit:      string
  default_par_level: number
  description:       string
}

export interface BulkImportedCatalogItem extends CatalogItemInput {
  id: string
}

export async function bulkImportCatalogItems(
  rows: BulkImportCatalogRow[]
): Promise<{ items?: BulkImportedCatalogItem[]; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const cleaned = rows
      .map((row) => ({
        name:              row.name.trim(),
        category:          row.category,
        default_unit:      row.default_unit.trim() || 'units',
        default_par_level: normalizeParLevel(row.default_par_level),
        description:       row.description.trim() || null,
        is_active:         true,
      }))
      .filter((row) => row.name)

    if (!cleaned.length) return { error: 'No valid rows to import.' }

    const { data, error } = await supabase
      .from('inventory_catalog')
      .insert(cleaned)
      .select('id, name, category, default_unit, default_par_level, description, is_active')

    if (error) {
      console.error('[bulkImportCatalogItems]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_catalog_item.bulk_imported',
      targetType: 'inventory_catalog',
      metadata:   { count: data?.length ?? 0 },
    })

    revalidatePath('/admin/inventory-catalog')
    return {
      items: (data ?? []).map((item) => ({
        id:                item.id,
        name:              item.name,
        category:          item.category,
        default_unit:      item.default_unit,
        default_par_level: item.default_par_level,
        description:       item.description ?? '',
        is_active:         item.is_active,
      })),
    }
  } catch (err) {
    console.error('[bulkImportCatalogItems]', err)
    reportError(err, { site: 'serverAction.admin.inventory-catalog.bulkImportCatalogItems' })
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
    reportError(err, { site: 'serverAction.admin.inventory-catalog.deleteCatalogItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}
