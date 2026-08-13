'use server'

import { revalidatePath } from 'next/cache'
import { verifyPropertyInOrg } from '@/lib/tenancy/verify'
import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { reportQueryError } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { fetchAllRows, SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'
import { rebaseParFromTarget } from '@/lib/inventory/par-engine'
import type { InventoryCategory, ParMode, ParSmartGroup, PoStatus, TablesInsert, TablesUpdate } from '@/types/database'
import { Constants } from '@/types/database'

/**
 * Deterministic, locale-independent string ordering for CANONICALISATION.
 *
 * Used to normalise a set of property ids into one stable representation for
 * an idempotency key — never for anything a user reads. Comparing by UTF-16
 * code unit (what `<`/`>` do) gives the same answer on every machine, in every
 * locale, under every ICU version; `String.localeCompare` does not, so two
 * environments could derive different keys for the same request and defeat the
 * dedup this key exists to provide. (Kept local rather than imported: this is
 * a `'use server'` module, where every export must be an async action.)
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export type InventoryActionState = { error?: string; success?: boolean }

// ── Update par level ─────────────────────────────────────────────────────────

interface CatalogParRow {
  id:          string
  par_mode:    ParMode
  smart_group: ParSmartGroup | null
  base_qty:    number
}

/**
 * Par config for the catalog items in a bulk add, keyed by catalog id.
 *
 * ONE query for every catalog id in the form, not one per row — a per-item
 * lookup inside the build loop is the N+1 that
 * unit/guardrails/n-plus-one-loops.test.ts exists to catch, and a bulk add can
 * carry the whole 157-item catalog.
 *
 * Non-fatal: a failure here returns an empty map and every item falls back to
 * the static default, which is exactly the behaviour before this existed. A PM
 * must not lose a filled-in bulk-add form over par metadata.
 */
async function fetchCatalogParConfig(
  supabase: Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  formData: FormData,
  itemCount: number,
): Promise<Map<string, CatalogParRow>> {
  const ids: string[] = []
  for (let i = 0; i < itemCount; i++) {
    const id = (formData.get(`item_${i}_catalog_item_id`) as string) || null
    if (id) ids.push(id)
  }
  if (!ids.length) return new Map()

  const res = await supabase
    .from('inventory_catalog')
    .select('id, par_mode, smart_group, base_qty')
    .in('id', ids)
    .limit(ids.length)
  if (reportQueryError(res.error, { site: 'serverAction.inventory.addInventoryItems.parConfig' })) {
    return new Map()
  }
  return new Map((res.data ?? []).map((r) => [r.id, r as CatalogParRow]))
}

/** The item row updateParLevel reads, with its property's size embedded. */
interface ParEditRow {
  par_mode:    ParMode
  smart_group: ParSmartGroup | null
  properties:  { bedrooms: number | null; bathrooms: number | null; max_guests: number | null }
             | { bedrooms: number | null; bathrooms: number | null; max_guests: number | null }[]
             | null
}

/**
 * Turns a typed par level into the columns to write.
 *
 * A STATIC item is left alone apart from its number — static is the PM saying
 * "this exact value", and re-basing it would silently make it scale.
 *
 * Extracted rather than inlined because updateParLevel would otherwise carry
 * the auth read, the embed unwrap, the branch and the write in one body, and
 * this is the part worth testing directly.
 */
function buildParPatch(row: ParEditRow, parLevel: number): TablesUpdate<'inventory_items'> {
  if (row.par_mode !== 'smart') return { par_level: parLevel }

  // PostgREST embeds come back as arrays even for a to-one relationship.
  const property = unwrapJoin(row.properties)
  const rebased  = rebaseParFromTarget(parLevel, { smart_group: row.smart_group }, {
    bedrooms:        property?.bedrooms   && property.bedrooms   > 0 ? property.bedrooms   : 1,
    bathrooms:       property?.bathrooms  && property.bathrooms  > 0 ? property.bathrooms  : 1,
    max_guests:      property?.max_guests && property.max_guests > 0 ? property.max_guests : 2,
    avg_stay_length: null,   // unused by the smart formula; only the historical branch reads it
  })

  return {
    par_mode:        rebased.par_mode,
    smart_group:     rebased.smart_group,
    base_qty:        rebased.base_qty,
    par_level:       rebased.par_level,
    auto_adjust:     rebased.auto_adjust,
    par_resolved_at: new Date().toISOString(),
  }
}

/**
 * A PM typing a par level RE-BASES a smart item rather than being overwritten
 * by it.
 *
 * Writing par_level alone was silent data loss. On a smart item par_level is a
 * cache of resolvePar(), so the PM's number survived only until the next
 * property edit or consumption sample recomputed it — and the inline editor
 * renders on every item, with no way to tell smart from static. 267 live items
 * were exposed to it. rebaseParFromTarget() inverts the smart formula so their
 * number is exact at the property's current size AND keeps scaling from there
 * if the property changes.
 *
 * The read is scoped by org before the write, and the write repeats the org
 * filter: the item id comes from the client, so membership alone does not
 * prove this item belongs to the caller's org.
 */
export async function updateParLevel(
  itemId: string,
  parLevel: number
): Promise<InventoryActionState> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const itemRes = await supabase
      .from('inventory_items')
      .select('id, par_mode, smart_group, properties(bedrooms, bathrooms, max_guests)')
      .eq('id', itemId)
      .eq('org_id', membership.org_id)
      .maybeSingle()
    if (reportQueryError(itemRes.error, { site: 'serverAction.inventory.updateParLevel', orgId: membership.org_id })) {
      return { error: 'Operation failed. Please try again.' }
    }
    if (!itemRes.data) return { error: 'Item not found.' }

    const patch = buildParPatch(itemRes.data, parLevel)

    const { error } = await supabase
      .from('inventory_items')
      .update(patch)
      .eq('id', itemId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[updateParLevel]', error)
      reportError(error, { site: 'serverAction.inventory.updateParLevel', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    revalidatePath('/inventory')
    return { success: true }
  } catch (err) {
    console.error('[updateParLevel]', err)
    reportError(err, { site: 'serverAction.inventory.updateParLevel' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Narrow a free-text category to the inventory_category enum the column
 * accepts, falling back to the column's own default.
 *
 * The valid labels come from Constants (generated from the live schema), not a
 * hand-written list — a second copy of an enum is a copy that drifts.
 */
function toInventoryCategory(value: string | null): InventoryCategory {
  const valid: readonly string[] = Constants.public.Enums.inventory_category
  return value !== null && valid.includes(value) ? (value as InventoryCategory) : 'other'
}

// ── Add inventory items (bulk) ───────────────────────────────────────────────

export async function addInventoryItems(
  _prev: InventoryActionState | null,
  formData: FormData
): Promise<InventoryActionState> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const property_id = formData.get('property_id') as string
    const itemCount   = parseInt(formData.get('item_count') as string, 10) || 0

    if (!property_id) return { error: 'Property is required' }
    if (itemCount === 0) return { error: 'Select at least one item' }

    // maybeSingle + reportQueryError: with .single() and a discarded error, a
    // failed read and "no such property in your org" produced the same answer.
    // The PM saw "Property not found" for a property they had just picked off
    // the list, and the whole filled-in bulk-add form was thrown away with
    // nothing logged.
    const owned = await verifyPropertyInOrg(supabase, membership.org_id, property_id, 'serverAction.inventory.addInventoryItems')
    if (!owned.ok) return { error: owned.error }

    // Par config for anything being added from the catalog. Without this every
    // hand-added item lands par_mode = 'static' (the column default) no matter
    // what its catalog row says — so a PM adding Pool Towels to a property that
    // has a pool got an item that never scales with bedrooms, bathrooms or
    // guests, and no UI to promote it. That is the whole add-your-own-items
    // workflow silently opting out of the par engine.
    const parByCatalogId = await fetchCatalogParConfig(supabase, formData, itemCount)

    const rows = []
    for (let i = 0; i < itemCount; i++) {
      const catalog_item_id = (formData.get(`item_${i}_catalog_item_id`) as string) || null
      const name     = (formData.get(`item_${i}_name`) as string)?.trim()
      const category = (formData.get(`item_${i}_category`) as InventoryCategory) || 'other'
      const unit     = (formData.get(`item_${i}_unit`) as string)?.trim()
      const par_level = parseFloat(formData.get(`item_${i}_par_level`) as string) || 1
      const notes    = (formData.get(`item_${i}_notes`) as string)?.trim() || null

      if (!name || !unit) continue

      // A catalog row that is itself static, or a hand-typed custom item, keeps
      // the static default — inheriting is not the same as forcing.
      const cat = catalog_item_id ? parByCatalogId.get(catalog_item_id) : undefined
      const parConfig = cat?.par_mode === 'smart' && cat.smart_group
        ? { par_mode: 'smart' as ParMode, smart_group: cat.smart_group, base_qty: Number(cat.base_qty) || 1 }
        : {}

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
        ...parConfig,
      })
    }

    if (rows.length === 0) return { error: 'No valid items to add' }

    const { error } = await supabase.from('inventory_items').insert(rows)
    if (error) {
      console.error('[addInventoryItems]', error)
      reportError(error, { site: 'serverAction.inventory.addInventoryItems', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    revalidatePath('/inventory')
    return { success: true }
  } catch (err) {
    console.error('[addInventoryItems]', err)
    reportError(err, { site: 'serverAction.inventory.addInventoryItems' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Submit inventory count ────────────────────────────────────────────────────

type CountItemRow = { count_id: string; inventory_item_id: string; quantity_counted: number }
type CountUpdate  = { id: string; current_quantity: number }

/**
 * Persists the count rows, then applies the counted quantities to live stock.
 *
 * Returns a user-facing message on failure, or `null` on success.
 *
 * The apply step is ONE set-based UPDATE, not one round-trip per item. The
 * previous per-item Promise.all discarded every result, so an RLS denial or a
 * bad item id applied a partial count and still reported success — stock
 * numbers that look freshly counted but are a mix of new and stale values,
 * which nobody re-counts because nothing looked wrong.
 *
 * first_count_recorded_at (the "0 means uncounted, not critical" distinction)
 * is COALESCE'd inside the same statement, which also removes the paginated
 * pre-read it used to need.
 */
async function recordAndApplyCount(
  supabase:   Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  orgId:      string,
  countItems: CountItemRow[],
  updates:    CountUpdate[],
): Promise<string | null> {
  const { error: itemsError } = await supabase
    .from('inventory_count_items')
    .insert(countItems)

  if (itemsError) {
    console.error('[submitInventoryCount] items insert', itemsError)
    reportError(itemsError, { site: 'serverAction.inventory.submitInventoryCount.items', orgId })
    return 'Failed to record inventory count items. Please try again.'
  }

  const { data: applied, error: applyError } = await supabase.rpc('apply_inventory_counts', {
    p_org_id: orgId,
    p_counts: updates.map((u) => ({ item_id: u.id, qty: u.current_quantity })),
  })

  if (applyError) {
    console.error('[submitInventoryCount] apply', applyError)
    reportError(applyError, { site: 'serverAction.inventory.submitInventoryCount.apply', orgId })
    return 'Failed to apply the counted quantities. Please try again.'
  }

  // A short count means some ids were not this org's items (or no longer
  // exist). The count rows are already recorded, so this is reported rather
  // than failed — but it is reported, not swallowed.
  if ((applied ?? 0) < updates.length) {
    console.warn('[submitInventoryCount] applied %d of %d counted items', applied ?? 0, updates.length)
  }

  return null
}

export async function submitInventoryCount(
  _prev: InventoryActionState | null,
  formData: FormData
): Promise<InventoryActionState> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const property_id = formData.get('property_id') as string
    const notes       = (formData.get('notes') as string)?.trim() || null

    if (!property_id) return { error: 'Property is required' }

    // Verify property belongs to org.
    // maybeSingle + reportQueryError for the same reason as addInventoryItems,
    // and it costs more here: a rejected submit discards a whole physical count
    // session the PM hand-entered, and "Property not found" gives them no
    // reason to retry.
    const owned = await verifyPropertyInOrg(
      supabase, membership.org_id, property_id,
      'serverAction.inventory.submitInventoryCount',
      'Could not verify the property. Your counts were not saved — please try again.',
    )
    if (!owned.ok) return { error: owned.error }

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
      reportError(countError, { site: 'serverAction.inventory.submitInventoryCount', orgId: membership.org_id })
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
      const recordError = await recordAndApplyCount(supabase, membership.org_id, countItems, updates)
      if (recordError) return { error: recordError }
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
  } catch (err) {
    console.error('[submitInventoryCount]', err)
    reportError(err, { site: 'serverAction.inventory.submitInventoryCount' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Template actions ──────────────────────────────────────────────────────────

export async function addTemplateItem(
  templateId: string,
  item: { name: string; category: string; unit: string; par_level: number; preferred_brand?: string | null }
): Promise<{ item?: { id: string; name: string; category: string; unit: string; par_level: number; notes: null; preferred_brand: string | null }; error?: string }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const templateRes = await supabase
      .from('inventory_templates')
      .select('id')
      .eq('id', templateId)
      .eq('org_id', membership.org_id)
      .maybeSingle()
    if (reportQueryError(templateRes.error, { site: 'serverAction.inventory.addTemplateItem', orgId: membership.org_id })) {
      return { error: 'Could not verify the template. Please try again.' }
    }
    if (!templateRes.data) return { error: 'Template not found.' }

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
      reportError(error, { site: 'serverAction.inventory.addTemplateItem' })
      return { error: 'Operation failed. Please try again.' }
    }
    revalidatePath('/inventory')
    return { item: data! as { id: string; name: string; category: string; unit: string; par_level: number; notes: null; preferred_brand: string | null } }
  } catch (err) {
    console.error('[addTemplateItem]', err)
    reportError(err, { site: 'serverAction.inventory.addTemplateItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Ownership gate for a single inventory_template_items row.
 *
 * inventory_template_items has no org_id of its own — ownership runs through
 * its parent template — and BOTH writes it guards (the brand update and the
 * delete) filter on .eq('id', itemId) alone. So this read is the only
 * application-level org scope on either statement, and RLS is the sole backstop
 * if it is ever loosened. Extracted so there is one copy of that reasoning
 * rather than two that can drift apart.
 */
async function verifyTemplateItemInOrg(
  supabase: Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  orgId:    string,
  itemId:   string,
  site:     string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await supabase
    .from('inventory_template_items')
    .select('id, inventory_templates!inner(org_id)')
    .eq('id', itemId)
    .eq('inventory_templates.org_id', orgId)
    .maybeSingle()

  if (reportQueryError(res.error, { site, orgId })) {
    return { ok: false, error: 'Could not verify the template item. Please try again.' }
  }
  if (!res.data) return { ok: false, error: 'Item not found' }

  return { ok: true }
}

export async function updateTemplateItemBrand(
  itemId: string,
  brand:  string | null
): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const owned = await verifyTemplateItemInOrg(supabase, membership.org_id, itemId, 'serverAction.inventory.updateTemplateItemBrand')
    if (!owned.ok) return { error: owned.error }

    const { error } = await supabase
      .from('inventory_template_items')
      .update({ preferred_brand: brand || null })
      .eq('id', itemId)

    if (error) {
      console.error('[updateTemplateItemBrand]', error)
      reportError(error, { site: 'serverAction.inventory.updateTemplateItemBrand', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    revalidatePath('/inventory')
    return {}
  } catch (err) {
    console.error('[updateTemplateItemBrand]', err)
    reportError(err, { site: 'serverAction.inventory.updateTemplateItemBrand' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function removeTemplateItem(itemId: string): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const owned = await verifyTemplateItemInOrg(supabase, membership.org_id, itemId, 'serverAction.inventory.removeTemplateItem')
    if (!owned.ok) return { error: owned.error }

    const { error } = await supabase
      .from('inventory_template_items')
      .delete()
      .eq('id', itemId)

    if (error) {
      console.error('[removeTemplateItem]', error)
      reportError(error, { site: 'serverAction.inventory.removeTemplateItem', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    revalidatePath('/inventory')
    return {}
  } catch (err) {
    console.error('[removeTemplateItem]', err)
    reportError(err, { site: 'serverAction.inventory.removeTemplateItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Ownership preamble for applyTemplateToProperties: the template must belong to
 * the caller's org, and every selected property must too.
 *
 * The property check is the ONLY thing standing between a client-supplied
 * property_id and a cross-org write — inventory_items' RLS INSERT check
 * verifies org_id but cannot verify that property_id belongs to that org (see
 * the caller's comment). So its failure must never share a branch with its
 * empty result: `ownedProperties ?? []` collapsed both into "you own none of
 * these", which told a PM who had ticked twelve of their own properties that
 * none were valid. That message blames the user's data for an outage, and it
 * is exactly the kind of message someone "fixes" by loosening the filter.
 *
 * Extracted from the action to keep it under the cognitive-complexity ceiling.
 */
type TemplateOwnership =
  | { ok: false; error: string }
  | { ok: true;  targetPropertyIds: string[] }

async function verifyTemplateAndProperties(
  supabase:    Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  orgId:       string,
  templateId:  string,
  propertyIds: string[],
): Promise<TemplateOwnership> {
  const templateRes = await supabase
    .from('inventory_templates')
    .select('id')
    .eq('id', templateId)
    .eq('org_id', orgId)
    .maybeSingle()

  if (reportQueryError(templateRes.error, { site: 'serverAction.inventory.applyTemplateToProperties', orgId })) {
    return { ok: false, error: 'Could not verify the template. Please try again.' }
  }
  if (!templateRes.data) return { ok: false, error: 'Template not found.' }

  // Paginated as well as error-checked: this is the tenant filter, so a
  // truncated page silently drops properties the PM does own — the same wrong
  // answer as a failed read, just quieter.
  let ownedRows: { id: string }[]
  try {
    ownedRows = await fetchAllRows<{ id: string }>(
      (from, to) => supabase
        .from('properties')
        .select('id')
        .eq('org_id', orgId)
        .in('id', propertyIds)
        .order('id')
        .range(from, to),
      { label: 'serverAction.inventory.applyTemplateToProperties.owned' },
    )
  } catch (err) {
    console.error('[applyTemplateToProperties] property verification failed', err)
    reportError(err, { site: 'serverAction.inventory.applyTemplateToProperties.owned', orgId })
    return { ok: false, error: 'Could not verify the selected properties. Nothing was applied — please try again.' }
  }

  const verified = new Set(ownedRows.map((p) => p.id))
  const targetPropertyIds = propertyIds.filter((id) => verified.has(id))
  if (targetPropertyIds.length === 0) return { ok: false, error: 'No valid properties selected' }

  return { ok: true, targetPropertyIds }
}

export async function applyTemplateToProperties(
  templateId: string,
  propertyIds: string[]
): Promise<{ error?: string; applied: number }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const ownership = await verifyTemplateAndProperties(supabase, membership.org_id, templateId, propertyIds)
    if (!ownership.ok) return { error: ownership.error, applied: 0 }
    const targetPropertyIds = ownership.targetPropertyIds

    // Bounded for the same reason the existing-items read below is paginated:
    // this set IS what gets written to every selected property, so a truncated
    // read stocks them with a partial list and reports success.
    const { data: items, error: itemsErr } = await supabase
      .from('inventory_template_items')
      .select('*')
      .eq('template_id', templateId)
      .limit(SUPABASE_MAX_ROWS)

    if (itemsErr || !items?.length) {
      if (itemsErr) {
        console.error('[applyTemplateToProperties]', itemsErr)
        reportError(itemsErr, { site: 'serverAction.inventory.applyTemplateToProperties', orgId: membership.org_id })
      }
      return { error: 'No items in template', applied: 0 }
    }

    // inventory_items_insert's RLS check only verifies org_id matches the
    // caller's org — it doesn't verify property_id itself belongs to that
    // org (there's no cross-table check available to it). Without this,
    // a propertyId for a different org would still pass RLS and get rows
    // inserted with a mismatched org_id/property_id pair. Verify explicitly
    // and drop anything that doesn't check out, same pattern as
    // clone_inventory_from_property's target-property check.

    // Fetch all existing items for ALL target properties, then group by property.
    //
    // Paginated, not a single unbounded select: PostgREST caps a response at
    // max_rows = 1000 with a 200 and no truncation signal, and this set IS the
    // duplicate guard below. At CLAUDE.md's own target scale (50 properties ×
    // a 115-item catalog = 5,750 rows) a truncated read meant every property
    // past the first ~8 got a full duplicate set of inventory items inserted,
    // silently. A unique index is not the fix here: the dedupe key is
    // two-pronged (catalog_item_id OR case-insensitive name) and live data
    // already contains duplicates this very bug created, so the index would
    // fail to build.
    const allExisting = await fetchAllRows<{ property_id: string; catalog_item_id: string | null; name: string }>(
      (from, to) => supabase
        .from('inventory_items')
        .select('property_id, catalog_item_id, name')
        .eq('org_id', membership.org_id)
        .in('property_id', targetPropertyIds)
        .order('id', { ascending: true })
        .range(from, to),
      { label: 'applyTemplateToProperties.existing_items' },
    )

    const existingByProperty: Record<string, { catalogIds: Set<string>; names: Set<string> }> = {}
    for (const row of allExisting) {
      if (!existingByProperty[row.property_id]) {
        existingByProperty[row.property_id] = { catalogIds: new Set(), names: new Set() }
      }
      if (row.catalog_item_id) existingByProperty[row.property_id]!.catalogIds.add(row.catalog_item_id)
      existingByProperty[row.property_id]!.names.add(row.name.toLowerCase())
    }

    let applied = 0
    // TablesInsert, not a hand-written shape: the previous annotation declared
    // `category: string`, which widened the inventory_category enum the column
    // actually accepts. Deriving the payload type from the schema means the
    // narrowing is checked here rather than discovered by PostgREST.
    const allToInsert: Array<TablesInsert<'inventory_items'>> = []

    for (const propertyId of targetPropertyIds) {
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
          source_template_id:      templateId,
          name:                    item.name,
          // inventory_template_items.category/unit are NULLABLE TEXT;
          // inventory_items.category/unit are NOT NULL (category is the
          // inventory_category enum). Copying one straight into the other let
          // a NULL or an off-enum string reach the insert, where Postgres
          // would reject it — and because this is a BULK insert, one bad
          // template row would fail the whole application, for every selected
          // property at once. The fallbacks are the column defaults declared
          // in the schema ('other' / 'units'), not invented values.
          category:                toInventoryCategory(item.category),
          unit:                    item.unit ?? 'units',
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
      const { error: insertErr } = await supabase.from('inventory_items').insert(allToInsert)
      if (insertErr) {
        console.error('[applyTemplateToProperties]', insertErr)
        reportError(insertErr, { site: 'serverAction.inventory.applyTemplateToProperties', orgId: membership.org_id })
        return { error: 'Operation failed. Please try again.', applied: 0 }
      }
    }

    revalidatePath('/inventory')
    return { applied }
  } catch (err) {
    console.error('[applyTemplateToProperties]', err)
    reportError(err, { site: 'serverAction.inventory.applyTemplateToProperties' })
    return { error: 'Operation failed. Please try again.', applied: 0 }
  }
}

// ── Aggregated purchase list ──────────────────────────────────────────────────

export interface AggregatedItem {
  name: string
  unit: string
  totalNeeded: number
  properties: Array<{ name: string; needed: number }>
}

interface AggregatedItemRow {
  name:                    string
  unit:                    string
  current_quantity:        number | null
  par_level:               number | null
  first_count_recorded_at: string | null
  property_id:             string
  property:                { name: string } | { name: string }[] | null
}

export async function generateAggregatedPurchaseList(): Promise<{ items: AggregatedItem[]; error?: string }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    // Supabase JS client can't compare two columns directly; fetch active items
    // and filter in JS.
    //
    // Was `.limit(2000)` with a comment claiming that was "well above any real
    // org's inventory" — CLAUDE.md's own target user (50 properties × a
    // 115-item catalog = 5,750 rows) exceeds it, and everything past row 2,000
    // was silently missing from the purchase list. Paginated instead, so the
    // bound is "all of them" rather than a guess.
    const allItems = await fetchAllRows<AggregatedItemRow>(
      (from, to) => supabase
        .from('inventory_items')
        .select('name, unit, current_quantity, par_level, first_count_recorded_at, property_id, property:properties(name)')
        .eq('org_id', membership.org_id)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to),
      { label: 'generateAggregatedPurchaseList.inventory_items' },
    )

    const grouped: Record<string, AggregatedItem> = {}
    for (const item of allItems) {
      if (!item.first_count_recorded_at) continue
      if ((item.current_quantity ?? 0) > (item.par_level ?? 0)) continue

      const key = item.name.toLowerCase()
      if (!grouped[key]) {
        grouped[key] = { name: item.name, unit: item.unit, totalNeeded: 0, properties: [] }
      }
      const needed = Math.max(0, (item.par_level ?? 0) - (item.current_quantity ?? 0))
      grouped[key]!.totalNeeded += needed
      const pName = unwrapJoin(item.property as { name: string } | { name: string }[] | null)?.name ?? '—'
      grouped[key]!.properties.push({ name: pName, needed })
    }

    return { items: Object.values(grouped).sort((a, b) => a.name.localeCompare(b.name)) }
  } catch (err) {
    console.error('[generateAggregatedPurchaseList]', err)
    reportError(err, { site: 'serverAction.inventory.generateAggregatedPurchaseList' })
    return { items: [], error: 'Operation failed. Please try again.' }
  }
}

// ── Purchase Order Status ─────────────────────────────────────────────────────

type PmSettablePoStatus = 'ordered' | 'received' | 'cancelled'

/**
 * The statuses a PM may set by hand, and what each one may move to.
 *
 * `draft` and `sent` are written by the restock pipeline itself
 * (lib/inngest/functions/inventory-events.ts), never by a person, so neither
 * is a destination here. `acknowledged` belongs to a vendor-acknowledgement
 * flow that does not exist for restock POs — there is no vendor on one — so it
 * is a source state only, never something the PM can select.
 *
 * `received` and `cancelled` are terminal: a PO that has been received cannot
 * be un-received, and reviving a cancelled one would fire
 * purchase-order/approved a second time against an unchanged
 * source_reference_id. (The owner_transactions upsert would swallow the
 * duplicate, but the ledger amount would then be frozen at whatever the first
 * attempt recorded, which is worse than refusing.)
 */
const PO_TRANSITIONS: Record<PoStatus, readonly PmSettablePoStatus[]> = {
  draft:        ['ordered', 'cancelled'],
  sent:         ['ordered', 'cancelled'],
  acknowledged: ['ordered', 'cancelled'],
  ordered:      ['received', 'cancelled'],
  received:     [],
  cancelled:    [],
}

/** Highest per-PO restock spend accepted, to catch a cents/dollars slip. */
const MAX_PO_TOTAL = 100_000

/**
 * Marks a restock purchase order as ordered / received / cancelled.
 *
 * This is the step that closes the inventory loop. Everything upstream of it
 * is automatic — a crew count fires `inventory/count-submitted`, the below-par
 * items become a PO, the PO is emailed to the PM (immediately for a same-day
 * flip, otherwise inside the daily wrap-up), and a connected Kroger account
 * gets a cart built from the same items. But the actual buying happens
 * OUTSIDE FieldStay in every one of those paths: the PM submits the cart on
 * kroger.com, or with no Kroger connection orders however they like. Nothing
 * tells us it happened, which is why this exists — and why it takes a cost.
 *
 * `purchase_orders.total_estimated_cost` is written NOWHERE else. The PO is
 * inserted with `total_estimated_cost: null` (a count carries quantities, not
 * prices) and no later step fills it in. `handlePurchaseOrderApproved` skips
 * on a null total, so before this parameter existed the restock expense could
 * not reach the owner ledger even if the event had fired: production has 1
 * purchase order, 136 line items, 0 non-null costs, and 0 `inventory_purchase`
 * owner_transactions. The amount the PM actually paid is the only trustworthy
 * figure available at any point in the flow, so it is captured here.
 */
export async function updatePurchaseOrderStatus(
  purchaseOrderId: string,
  status: PmSettablePoStatus,
  totalCost?: number | null,
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    // NaN defeats `??` and every `> 0` comparison silently, so Number.isFinite
    // is the guard, not a nullish check — an unparseable amount must be
    // rejected outright rather than written to the ledger as a garbage number.
    if (totalCost !== undefined && totalCost !== null) {
      if (!Number.isFinite(totalCost) || totalCost < 0 || totalCost > MAX_PO_TOTAL) {
        return { error: 'Enter a total between $0 and $100,000.' }
      }
    }

    // This row is all-or-nothing: it decides the idempotent no-op, supplies
    // old_status for the audit row, and carries property_id +
    // total_estimated_cost into purchase-order/approved. A silent null skipped
    // the whole transition — the PO sat in `sent` forever, no event fired, so
    // the downstream restock expense never reached the owner ledger, and the PM
    // was told the PO did not exist.
    const poRes = await supabase
      .from('purchase_orders')
      .select('id, property_id, total_estimated_cost, status')
      .eq('id', purchaseOrderId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(poRes.error, { site: 'serverAction.inventory.updatePurchaseOrderStatus', orgId: membership.org_id })) {
      return { error: 'Could not load the purchase order. Please try again.' }
    }
    const po = poRes.data
    if (!po) return { error: 'Purchase order not found' }
    if (po.status === status) return {}

    const allowed = PO_TRANSITIONS[po.status as PoStatus] ?? []
    if (!allowed.includes(status)) {
      return { error: `A ${po.status} purchase order cannot be marked ${status}.` }
    }

    const statusUpdate: TablesUpdate<'purchase_orders'> = { status }
    // Only carried on the transition that spends money. Rounded to cents:
    // a raw float from a text input reaches the owner ledger otherwise.
    const resolvedCost = totalCost === undefined || totalCost === null
      ? po.total_estimated_cost
      : Math.round(totalCost * 100) / 100
    if (status === 'ordered' && resolvedCost !== po.total_estimated_cost) {
      statusUpdate.total_estimated_cost = resolvedCost
    }

    // `.eq('status', po.status)` makes this a compare-and-swap rather than a
    // blind write. Two PMs marking the same PO ordered at once both read
    // `sent` above and would both fall through; the precondition means exactly
    // one UPDATE matches a row, so exactly one fires purchase-order/approved
    // and writes an audit entry. (The owner_transactions upsert would have
    // absorbed the duplicate expense, but the second event would still have
    // overwritten nothing while logging a second, false status change.)
    const { data: updated, error } = await supabase
      .from('purchase_orders')
      .update(statusUpdate)
      .eq('id', purchaseOrderId)
      .eq('org_id', membership.org_id)
      .eq('status', po.status)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[updatePurchaseOrderStatus]', error)
      reportError(error, { site: 'serverAction.inventory.updatePurchaseOrderStatus', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    // No error and no row means the compare-and-swap lost — someone else moved
    // this PO between the read and the write. Distinguished from a failure so
    // the PM is told what actually happened instead of retrying into the same
    // race. Not an error to report: it is the guard working.
    if (!updated) {
      return { error: 'Someone else updated this purchase order. Refresh and try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'purchase_order.status_changed',
      targetType: 'purchase_order',
      targetId:   purchaseOrderId,
      // The spend itself is deliberately absent — audit metadata is not a
      // second home for financial specifics (CLAUDE.md, sensitive-data rule).
      metadata:   { old_status: po.status, new_status: status },
    })

    if (status === 'ordered') {
      await inngest.send({
        name: 'purchase-order/approved',
        data: {
          purchase_order_id:    purchaseOrderId,
          property_id:          po.property_id,
          org_id:               membership.org_id,
          total_estimated_cost: resolvedCost,
        },
      })
    }

    revalidatePath('/inventory')
    return {}
  } catch (err) {
    console.error('[updatePurchaseOrderStatus]', err)
    reportError(err, { site: 'serverAction.inventory.updatePurchaseOrderStatus' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Shopping Cart ──────────────────────────────────────────────────

export async function triggerShoppingCart(
  propertyIds?: string[],
  modality: 'PICKUP' | 'DELIVERY' | 'IN_STORE' = 'PICKUP'
): Promise<{ success: boolean; error?: string }> {
  const { user, membership } = await requireOrgMember()

  // Idempotency key for the SEND, not the cart contents.
  //
  // buildShoppingCart already makes duplicate Kroger cart additions
  // impossible — concurrency { limit: 1, key: 'event.data.org_id' } serialises
  // runs per org, and its step-6 claim is keyed on a content fingerprint of
  // the exact cart. What neither of those stops is a second RUN existing at
  // all: a double-clicked "Build Cart" produced two runs, the second of which
  // no-ops on the cart and then still emails the PM a second "your cart is
  // ready". This collapses the duplicate at the source.
  //
  // Bucketed to the minute rather than the day: Inngest's own event `id`
  // dedup window is 24h, and a PM who fixes a par level and rebuilds five
  // minutes later is doing something legitimate that must not be swallowed.
  // A minute is far longer than any double-click and far shorter than any
  // deliberate rebuild. Two clicks straddling a bucket boundary fall through
  // to the fingerprint claim, which is the correctness guarantee — this is
  // purely about not sending the same email twice.
  const minuteBucket = Math.floor(Date.now() / 60_000)
  // Canonicalisation sort — see compareCodeUnits above: the key must not
  // depend on the order the caller listed the properties in, and must not
  // depend on the runtime's locale either.
  const propertyScope = propertyIds?.length ? [...propertyIds].sort(compareCodeUnits).join(',') : 'all'
  const eventId = `cart-requested:${membership.org_id}:${user.id}:${modality}:${propertyScope}:${minuteBucket}`

  try {
    await inngest.send({
      id:   eventId,
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
    reportError(err, { site: 'serverAction.inventory.triggerShoppingCart', orgId: membership.org_id })
    return { success: false, error: 'Failed to start cart build. Try again.' }
  }
}