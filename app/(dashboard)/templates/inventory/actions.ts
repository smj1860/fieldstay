'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import type { InventoryCategory } from '@/types/database'

// ── Master List (org_inventory_catalog) ─────────────────────────────────────

export async function createCatalogItem(
  name: string,
  category: InventoryCategory,
  defaultUnit: string
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const trimmedName = name.trim()
    const trimmedUnit = defaultUnit.trim()
    if (!trimmedName) return { error: 'Item name is required.' }
    if (!trimmedUnit) return { error: 'Unit is required.' }

    const { data, error } = await supabase
      .from('org_inventory_catalog')
      .insert({ org_id: membership.org_id, name: trimmedName, category, default_unit: trimmedUnit })
      .select('id')
      .single()

    if (error || !data) {
      console.error('[createCatalogItem]', error)
      reportError(error, { site: 'serverAction.templatesInventory.createCatalogItem', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org_inventory_catalog_item.created',
      targetType: 'org_inventory_catalog',
      targetId:   data.id,
      metadata:   { name: trimmedName, category },
    })

    revalidatePath('/templates/inventory/master-list')
    return { id: data.id }
  } catch (err) {
    console.error('[createCatalogItem]', err)
    reportError(err, { site: 'serverAction.templatesInventory.createCatalogItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function updateCatalogItem(
  itemId: string,
  updates: { name?: string; category?: InventoryCategory; default_unit?: string }
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const patch: Record<string, string> = {}
    if (updates.name !== undefined) {
      const trimmed = updates.name.trim()
      if (!trimmed) return { error: 'Item name is required.' }
      patch.name = trimmed
    }
    if (updates.category !== undefined) patch.category = updates.category
    if (updates.default_unit !== undefined) {
      const trimmed = updates.default_unit.trim()
      if (!trimmed) return { error: 'Unit is required.' }
      patch.default_unit = trimmed
    }
    if (Object.keys(patch).length === 0) return {}

    const { data, error } = await supabase
      .from('org_inventory_catalog')
      .update(patch)
      .eq('id', itemId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[updateCatalogItem]', error)
      reportError(error, { site: 'serverAction.templatesInventory.updateCatalogItem', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Item not found.' }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org_inventory_catalog_item.updated',
      targetType: 'org_inventory_catalog',
      targetId:   itemId,
      metadata:   patch,
    })

    revalidatePath('/templates/inventory/master-list')
    return {}
  } catch (err) {
    console.error('[updateCatalogItem]', err)
    reportError(err, { site: 'serverAction.templatesInventory.updateCatalogItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteCatalogItem(itemId: string): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data, error } = await supabase
      .from('org_inventory_catalog')
      .delete()
      .eq('id', itemId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[deleteCatalogItem]', error)
      reportError(error, { site: 'serverAction.templatesInventory.deleteCatalogItem', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Item not found.' }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org_inventory_catalog_item.deleted',
      targetType: 'org_inventory_catalog',
      targetId:   itemId,
    })

    revalidatePath('/templates/inventory/master-list')
    return {}
  } catch (err) {
    console.error('[deleteCatalogItem]', err)
    reportError(err, { site: 'serverAction.templatesInventory.deleteCatalogItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Create Template ──────────────────────────────────────────────────────────

// Checkbox-select only, matching the confirmed design — no quantities
// collected here. inventory_template_items.par_level is left at its
// column default (1) and par_qty (unused, see Pass 1/3 self-audit) is
// never written by this codebase at all.
//
// CORRECTION (Pass 3 Addendum self-audit): the original version of this
// function set inventory_template_items.catalog_item_id to the selected
// org_inventory_catalog row's own id. That column is a foreign key to the
// GLOBAL inventory_catalog table (20260612021647_fix_inventory_template_
// items_columns.sql), not to org_inventory_catalog — org_inventory_catalog
// ids are freshly generated per org and essentially never coincide with a
// real inventory_catalog id, so every insert here was failing the FK
// constraint and getting rolled back by the orphaned-template cleanup
// below. Create Template was non-functional for any selection since Pass
// 3 shipped. Fixed by using platform_catalog_item_id — the org catalog
// row's own pointer back to its platform origin — which is exactly what
// that FK expects, and is null (correctly) for an org's own custom items.
export async function createInventoryTemplate(
  name: string,
  selectedCatalogItemIds: string[],
  brandByItemId: Record<string, string | null> = {}
): Promise<{ templateId?: string; error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const trimmedName = name.trim()
    if (!trimmedName) return { error: 'Template name is required.' }
    if (selectedCatalogItemIds.length === 0) return { error: 'Select at least one item.' }

    const { data: catalogItems, error: catalogError } = await supabase
      .from('org_inventory_catalog')
      .select('id, name, category, default_unit, platform_catalog_item_id')
      .eq('org_id', membership.org_id)
      .in('id', selectedCatalogItemIds)

    if (catalogError || !catalogItems?.length) {
      console.error('[createInventoryTemplate] catalog fetch', catalogError)
      reportError(catalogError, { site: 'serverAction.templatesInventory.createInventoryTemplate', orgId: membership.org_id })
      return { error: 'Selected items not found.' }
    }

    const { data: template, error: templateError } = await supabase
      .from('inventory_templates')
      .insert({ org_id: membership.org_id, name: trimmedName })
      .select('id')
      .single()

    if (templateError || !template) {
      console.error('[createInventoryTemplate] template insert', templateError)
      reportError(templateError, { site: 'serverAction.templatesInventory.createInventoryTemplate', orgId: membership.org_id })
      // Pass 1's inventory_templates_org_name_unique means this is most
      // often a duplicate name within the org, not a generic failure.
      return { error: 'A template with that name already exists.' }
    }

    const { error: itemsError } = await supabase.from('inventory_template_items').insert(
      catalogItems.map((item) => ({
        template_id:     template.id,
        catalog_item_id: item.platform_catalog_item_id ?? null,
        name:            item.name,
        category:        item.category,
        unit:            item.default_unit,
        preferred_brand: brandByItemId[item.id]?.trim() || null,
      }))
    )

    if (itemsError) {
      console.error('[createInventoryTemplate] items insert', itemsError)
      reportError(itemsError, { site: 'serverAction.templatesInventory.createInventoryTemplate', orgId: membership.org_id })
      // Don't leave an empty, orphaned template behind — the items insert
      // failing after the template insert succeeded is a partial-write, not
      // a fully-failed one, and this is a user-initiated one-shot action
      // with no idempotent retry path like a background job would have.
      await supabase.from('inventory_templates').delete().eq('id', template.id)
      return { error: 'Failed to save template items. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'inventory_template.created',
      targetType: 'inventory_template',
      targetId:   template.id,
      metadata:   { name: trimmedName, item_count: catalogItems.length },
    })

    revalidatePath('/templates/inventory/saved')
    revalidatePath('/templates/inventory/create')
    return { templateId: template.id }
  } catch (err) {
    console.error('[createInventoryTemplate]', err)
    reportError(err, { site: 'serverAction.templatesInventory.createInventoryTemplate' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Create Template from CSV ─────────────────────────────────────────────────
// Addendum's second way to arrive at a new template's item list — same
// "create empty template, then populate it, roll back on partial failure"
// shape as createInventoryTemplate above, but items come from parsed CSV
// rows instead of catalog-row ids. catalog_item_id is resolved by a single
// case-insensitive batch name-match against org_inventory_catalog (not a
// query per row) — matches by name only when that org catalog row also
// has a platform origin; a name match against a purely custom org item
// (platform_catalog_item_id null) correctly leaves catalog_item_id null,
// since there's nothing in the global catalog to point at.
export async function createInventoryTemplateFromCSV(
  name: string,
  rows: Array<{
    name:             string
    category:         InventoryCategory
    unit:             string
    par_level?:       number
    preferred_brand?: string | null
  }>
): Promise<{ templateId?: string; error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const trimmedName = name.trim()
    if (!trimmedName) return { error: 'Template name is required.' }
    if (rows.length === 0) return { error: 'No items to add.' }

    const { data: catalogMatches, error: catalogError } = await supabase
      .from('org_inventory_catalog')
      .select('name, platform_catalog_item_id')
      .eq('org_id', membership.org_id)

    if (catalogError) {
      console.error('[createInventoryTemplateFromCSV] catalog fetch', catalogError)
      reportError(catalogError, { site: 'serverAction.templatesInventory.createInventoryTemplateFromCSV', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    const catalogIdByLowerName = new Map<string, string | null>()
    for (const row of catalogMatches ?? []) {
      catalogIdByLowerName.set(row.name.toLowerCase(), row.platform_catalog_item_id)
    }

    const { data: template, error: templateError } = await supabase
      .from('inventory_templates')
      .insert({ org_id: membership.org_id, name: trimmedName })
      .select('id')
      .single()

    if (templateError || !template) {
      console.error('[createInventoryTemplateFromCSV] template insert', templateError)
      reportError(templateError, { site: 'serverAction.templatesInventory.createInventoryTemplateFromCSV', orgId: membership.org_id })
      return { error: 'A template with that name already exists.' }
    }

    const { error: itemsError } = await supabase.from('inventory_template_items').insert(
      rows.map((row) => ({
        template_id:     template.id,
        catalog_item_id: catalogIdByLowerName.get(row.name.toLowerCase()) ?? null,
        name:            row.name,
        category:        row.category,
        unit:            row.unit,
        // The addendum's spec said "default to 0, same as the column's own
        // default" — that's actually inventory_items.par_level's default;
        // inventory_template_items.par_level defaults to 1
        // (20260618000002_baseline_schema_snapshot.sql). Using the real
        // column default here, not the addendum's mixed-up one.
        par_level:       row.par_level ?? 1,
        preferred_brand: row.preferred_brand?.trim() || null,
      }))
    )

    if (itemsError) {
      console.error('[createInventoryTemplateFromCSV] items insert', itemsError)
      reportError(itemsError, { site: 'serverAction.templatesInventory.createInventoryTemplateFromCSV', orgId: membership.org_id })
      await supabase.from('inventory_templates').delete().eq('id', template.id)
      return { error: 'Failed to save template items. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'inventory_template.created',
      targetType: 'inventory_template',
      targetId:   template.id,
      metadata:   { name: trimmedName, item_count: rows.length, source: 'csv' },
    })

    revalidatePath('/templates/inventory/saved')
    revalidatePath('/templates/inventory/create')
    return { templateId: template.id }
  } catch (err) {
    console.error('[createInventoryTemplateFromCSV]', err)
    reportError(err, { site: 'serverAction.templatesInventory.createInventoryTemplateFromCSV' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Par Levels property editor ───────────────────────────────────────────────
// Reimplemented against this editor's own state shape rather than moved
// verbatim from the old properties/[id]/setup/inventory screen — see
// CLAUDE_TEMPLATES_3_INVENTORY.md Section 5.

interface ParLevelItemInput {
  id?: string
  catalog_item_id?: string | null
  name: string
  category: InventoryCategory
  unit: string
  par_level: number
  preferred_brand?: string | null
}

interface ParLevelItemRow {
  id:                 string
  property_id:        string
  catalog_item_id:    string | null
  source_template_id: string | null
  name:               string
  category:           InventoryCategory
  unit:               string
  par_level:          number
  preferred_brand:    string | null
}

// Returns the saved rows (real DB ids included) rather than just {error?} —
// a caller that keeps client-side item state (the Par Levels editor) needs
// real ids back for newly-inserted items, not the client-generated
// placeholder ids used before save. Without this, editing or deleting a
// just-added item again in the same session (no page reload) would either
// silently fail (delete against a nonexistent id) or double-insert (a
// second save mistaking it for still-new).
export async function upsertParLevelItems(
  propertyId: string,
  items: ParLevelItemInput[]
): Promise<{ error?: string; items?: ParLevelItemRow[] }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    // Verify propertyId belongs to this org before using it — RLS on
    // inventory_items_insert only checks the row's own org_id, not that
    // property_id itself belongs to that org (see
    // 20260722000000_atomic_template_item_replace.sql, which closed this
    // same gap for cloneInventoryFromProperty's target property but not
    // for this function's new-item insert path below).
    const { data: property } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (!property) return { error: 'Property not found' }

    const existingItems = items.filter((item) => item.id)
    const newItems      = items.filter((item) => !item.id)
    const savedItems: ParLevelItemRow[] = []

    if (existingItems.length) {
      // Confirm every client-supplied id already belongs to this org
      // before upserting — RLS backstops this, but a client-supplied id
      // for another org's row should never reach the upsert call.
      const { data: verifiedRows } = await supabase
        .from('inventory_items')
        .select('id')
        .in('id', existingItems.map((item) => item.id!))
        .eq('org_id', membership.org_id)
      const verifiedIds   = new Set((verifiedRows ?? []).map((r) => r.id))
      const verifiedItems = existingItems.filter((item) => verifiedIds.has(item.id!))

      if (verifiedItems.length) {
        // source_template_id is deliberately never included in this SET —
        // editing an item's par level/unit/brand doesn't change where its
        // content originally came from.
        const { data, error } = await supabase.from('inventory_items').upsert(
          verifiedItems.map((item) => ({
            id:              item.id,
            org_id:          membership.org_id,
            property_id:     propertyId,
            name:            item.name,
            category:        item.category,
            unit:            item.unit,
            par_level:       item.par_level,
            preferred_brand: item.preferred_brand ?? null,
          })),
          { onConflict: 'id' }
        )
          .select('id, property_id, catalog_item_id, source_template_id, name, category, unit, par_level, preferred_brand')
        if (error) {
          console.error('[upsertParLevelItems] update', error)
          reportError(error, { site: 'serverAction.templatesInventory.upsertParLevelItems', orgId: membership.org_id })
          return { error: 'Operation failed. Please try again.' }
        }
        savedItems.push(...(data ?? []))
      }
    }

    if (newItems.length) {
      const { data, error } = await supabase.from('inventory_items').insert(
        newItems.map((item) => ({
          property_id:      propertyId,
          org_id:            membership.org_id,
          catalog_item_id:   item.catalog_item_id ?? null,
          name:              item.name,
          category:          item.category,
          unit:              item.unit,
          par_level:         item.par_level,
          current_quantity:  0,
          preferred_brand:   item.preferred_brand ?? null,
          is_active:         true,
        }))
      )
        .select('id, property_id, catalog_item_id, source_template_id, name, category, unit, par_level, preferred_brand')
      if (error) {
        console.error('[upsertParLevelItems] insert', error)
        reportError(error, { site: 'serverAction.templatesInventory.upsertParLevelItems', orgId: membership.org_id })
        return { error: 'Operation failed. Please try again.' }
      }
      savedItems.push(...(data ?? []))
    }

    revalidatePath('/templates/inventory/par-levels')
    return { items: savedItems }
  } catch (err) {
    console.error('[upsertParLevelItems]', err)
    reportError(err, { site: 'serverAction.templatesInventory.upsertParLevelItems' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteParLevelItem(itemId: string): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data, error } = await supabase
      .from('inventory_items')
      .delete()
      .eq('id', itemId)
      .eq('org_id', membership.org_id)
      .select('id, property_id')
      .maybeSingle()

    if (error) {
      console.error('[deleteParLevelItem]', error)
      reportError(error, { site: 'serverAction.templatesInventory.deleteParLevelItem', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Item not found.' }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'inventory.item.deleted',
      targetType: 'inventory_item',
      targetId:   itemId,
      metadata:   { property_id: data.property_id },
    })

    revalidatePath('/templates/inventory/par-levels')
    return {}
  } catch (err) {
    console.error('[deleteParLevelItem]', err)
    reportError(err, { site: 'serverAction.templatesInventory.deleteParLevelItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Clone from another property ──────────────────────────────────────────────
// Moved from properties/[id]/setup/inventory/actions.ts (deleted in this
// pass) for reuse in the Par Levels property editor — see self-audit
// item 3 in CLAUDE_TEMPLATES_3_INVENTORY.md. Body unchanged; only the
// revalidatePath target moved with it.

export async function cloneInventoryFromProperty(
  sourcePropertyId: string,
  targetPropertyId: string,
): Promise<{ added: number; skipped: number; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    // Ownership of targetPropertyId, the dup-check race, and the actual
    // insert all happen inside one RPC — see
    // 20260722000000_atomic_template_item_replace.sql for why a plain
    // client-side check-then-insert here was both an IDOR gap (no org
    // check on the target property) and a TOCTOU race.
    const { data: cloneResult, error } = await supabase.rpc('clone_inventory_from_property', {
      p_org_id:             membership.org_id,
      p_source_property_id: sourcePropertyId,
      p_target_property_id: targetPropertyId,
    })

    if (error) {
      console.error('[cloneInventoryFromProperty]', error)
      reportError(error, { site: 'serverAction.templatesInventory.cloneInventoryFromProperty', orgId: membership.org_id })
      return { added: 0, skipped: 0, error: 'Operation failed. Please try again.' }
    }

    const rows = cloneResult as { added: number; skipped: number; source_count: number }[] | null
    const data = rows?.[0]
    if (!data || data.source_count === 0) {
      return { added: 0, skipped: 0, error: 'Source property has no inventory items' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'property.inventory.cloned',
      targetType: 'property',
      targetId:   targetPropertyId,
      metadata:   { sourcePropertyId, added: data.added, skipped: data.skipped },
    })

    revalidatePath('/templates/inventory/par-levels')
    return { added: data.added, skipped: data.skipped }
  } catch (err) {
    console.error('[cloneInventoryFromProperty]', err)
    reportError(err, { site: 'serverAction.templatesInventory.cloneInventoryFromProperty' })
    return { added: 0, skipped: 0, error: 'Operation failed. Please try again.' }
  }
}
