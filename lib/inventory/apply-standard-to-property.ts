import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { Constants, type InventoryCategory } from '@/types/database'
import { unwrapList, tryUnwrap } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { getStandardInventoryTemplateId } from './standard-template'

/**
 * Leg 3: put the standard inventory on a property the moment it is created.
 *
 * Checklists have had this leg since day one — createProperty calls
 * applyMasterChecklistToProperty two lines from where this is called. Inventory
 * never did, and the property setup wizard has a step whose entire content is a
 * sign reading "Inventory Isn't Set Up Automatically". This is what removes it.
 *
 * Source preference, and the reason it is a preference rather than one source:
 *
 *   1. The ORG's own copy of the standard (inventory_templates where
 *      source_platform_template_id = the standard). A PM who has adjusted their
 *      par levels must get THEIR numbers on a new property, not the platform's.
 *   2. Failing that, the PLATFORM template directly.
 *
 * Falling back matters more than it looks. The org copy is created by leg 2's
 * Inngest function at signup, so it is absent for (a) the seconds between
 * signup and that function landing, and (b) every org that existed before leg 2
 * shipped — which today is all of them. Without the fallback the feature would
 * silently do nothing for every current customer until someone pressed
 * Broadcast.
 *
 * Returns a count and the source rather than throwing on "nothing to do":
 * no standard designated and an empty template are both ordinary states.
 */

export interface ApplyStandardResult {
  applied: number
  source:  'org_template' | 'platform_template' | 'none'
}

interface SourceItem {
  catalog_item_id: string | null
  name:            string
  category:        string | null
  unit:            string | null
  par_level:       number
  par_mode:        string
  smart_group:     string | null
  base_qty:        number
  preferred_brand: string | null
}

/** Narrow free text to the inventory_category enum, from Constants (generated
 *  from the live schema) rather than a hand-written list that would drift. */
function toInventoryCategory(value: string | null): InventoryCategory {
  const valid: readonly string[] = Constants.public.Enums.inventory_category
  return value !== null && valid.includes(value) ? (value as InventoryCategory) : 'other'
}

/** Bounded: a template is a curated list (86 items today). The explicit cap
 *  documents that and keeps this out of the unbounded-select class. */
const TEMPLATE_ITEM_CAP = 500

async function loadOrgTemplateItems(
  supabase: SupabaseClient,
  orgId: string,
  platformTemplateId: string,
): Promise<{ templateId: string; items: SourceItem[] } | null> {
  const tplRes = await supabase
    .from('inventory_templates')
    .select('id')
    .eq('org_id', orgId)
    .eq('source_platform_template_id', platformTemplateId)
    .maybeSingle()

  const tpl = tryUnwrap<{ id: string }>(tplRes, {
    site: 'lib.inventory.applyStandardToProperty.orgTemplate', orgId,
  })
  if (!tpl.ok || !tpl.data) return null

  // The await is bound to a const before unwrapping, not inlined into the
  // call. A generic type argument stops semgrep's `$F(await ...)` exemption
  // from matching, so the inline form trips the discarded-result chokepoint on
  // a result that is in fact handled.
  const itemsRes = await supabase
    .from('inventory_template_items')
    .select('catalog_item_id, name, category, unit, par_level, par_mode, smart_group, base_qty, preferred_brand')
    .eq('template_id', tpl.data.id)
    .limit(TEMPLATE_ITEM_CAP)
  const items = unwrapList<SourceItem>(itemsRes,
    { site: 'lib.inventory.applyStandardToProperty.orgTemplateItems', orgId })
  return { templateId: tpl.data.id, items }
}

interface CatalogEmbed { name: string; category: string; default_unit: string }

interface PlatformItemRow {
  catalog_item_id: string
  par_level:       number
  par_mode:        string
  smart_group:     string | null
  base_qty:        number
  preferred_brand: string | null
  // PostgREST embeds arrive as an ARRAY, never a single object, even for a
  // to-one relationship — hence unwrapJoin below rather than a direct read.
  inventory_catalog: CatalogEmbed | CatalogEmbed[] | null
}

async function loadPlatformTemplateItems(
  supabase: SupabaseClient,
  orgId: string,
  platformTemplateId: string,
): Promise<SourceItem[]> {
  const rowsRes = await supabase
    .from('platform_inventory_template_items')
    .select('catalog_item_id, par_level, par_mode, smart_group, base_qty, preferred_brand, inventory_catalog(name, category, default_unit)')
    .eq('platform_inventory_template_id', platformTemplateId)
    .limit(TEMPLATE_ITEM_CAP)
  const rows = unwrapList<PlatformItemRow>(rowsRes,
    { site: 'lib.inventory.applyStandardToProperty.platformTemplateItems', orgId })

  return rows.flatMap((r) => {
    const catalog = unwrapJoin(r.inventory_catalog)
    // The embed is the item's identity — without it there is no name to write
    // into the NOT NULL column. Skip rather than invent a placeholder.
    if (!catalog) return []
    return [{
      catalog_item_id: r.catalog_item_id,
      name:            catalog.name,
      category:        catalog.category,
      unit:            catalog.default_unit,
      par_level:       r.par_level,
      par_mode:        r.par_mode,
      smart_group:     r.smart_group,
      base_qty:        r.base_qty,
      preferred_brand: r.preferred_brand,
    }]
  })
}

export async function applyStandardInventoryToProperty(
  propertyId: string,
  orgId: string,
  supabase: SupabaseClient,
): Promise<ApplyStandardResult> {
  const platformTemplateId = await getStandardInventoryTemplateId(supabase, {
    site: 'lib.inventory.applyStandardToProperty', orgId,
  })
  if (!platformTemplateId) return { applied: 0, source: 'none' }

  const org = await loadOrgTemplateItems(supabase, orgId, platformTemplateId)
  const source: ApplyStandardResult['source'] = org ? 'org_template' : 'platform_template'
  const items = org ? org.items : await loadPlatformTemplateItems(supabase, orgId, platformTemplateId)
  if (!items.length) return { applied: 0, source }

  // Dedup on BOTH keys, matching applyTemplateToProperties. catalog_item_id
  // alone misses an item a PM typed by hand, and name alone misses one whose
  // catalog row was renamed since — this property already holds a row for it
  // either way, and a second one would double every restock count.
  const existingRes = await supabase
    .from('inventory_items')
    .select('catalog_item_id, name')
    .eq('property_id', propertyId)
    .limit(TEMPLATE_ITEM_CAP * 2)
  const existing = unwrapList<{ catalog_item_id: string | null; name: string }>(existingRes,
    { site: 'lib.inventory.applyStandardToProperty.existing', orgId })
  const haveCatalogIds = new Set(existing.map((e) => e.catalog_item_id).filter(Boolean))
  const haveNames      = new Set(existing.map((e) => e.name.toLowerCase()))

  const toInsert = items
    .filter((i) => !(i.catalog_item_id && haveCatalogIds.has(i.catalog_item_id)))
    .filter((i) => !haveNames.has(i.name.toLowerCase()))
    .map((i) => ({
      property_id:             propertyId,
      org_id:                  orgId,
      catalog_item_id:         i.catalog_item_id,
      // Provenance, matching applyTemplateToProperties. Null on the platform
      // fallback path — there is no org template row to point at, and
      // inventing one would claim a link that does not exist.
      source_template_id:      org?.templateId ?? null,
      name:                    i.name,
      // Both columns are NOT NULL on inventory_items but nullable on the
      // template, so the fallbacks are the column defaults, not invented values.
      category:                toInventoryCategory(i.category),
      unit:                    i.unit ?? 'units',
      par_level:               i.par_level,
      par_mode:                i.par_mode,
      smart_group:             i.smart_group,
      base_qty:                i.base_qty,
      preferred_brand:         i.preferred_brand,
      current_quantity:        0,
      low_stock_threshold_pct: 20,
      is_active:               true,
    }))

  if (!toInsert.length) return { applied: 0, source }

  const { error } = await supabase.from('inventory_items').insert(toInsert)
  if (error) throw error

  return { applied: toInsert.length, source }
}
