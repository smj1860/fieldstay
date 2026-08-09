/**
 * Broadcasts a platform inventory template (e.g. the "Standard FieldStay
 * Inventory Template") to every org, or a selected set of orgs. Additive
 * only, per the source of truth for this design: an org's own
 * customizations to an item it already has (par_level, preferred_brand)
 * are never touched, and an item is never removed from an org's template
 * just because it was removed from the master — this only ever ADDS
 * items the org doesn't have yet from the master template's current list.
 *
 * Fans out one step.run per org — same shape as generateCapexProjections
 * (capex-projections.ts) — so a run covering thousands of orgs retries
 * per-org, not from the top.
 */

import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents }      from '@/lib/audit'
import { unwrap }  from '@/lib/supabase/unwrap'

interface MasterItem {
  catalog_item_id: string
  par_level:       number
  preferred_brand: string | null
  sort_order:      number
  name:            string
  category:        string
  unit:            string
}

/**
 * The master item list for a platform template, joined to the catalog.
 *
 * Module-level so the dispatcher and the per-org handler resolve it the same
 * way. The handler re-reads it rather than receiving it on the event: two ids
 * on the wire beats a ~115-item array repeated across every org in the
 * broadcast, and it keeps the handler self-contained enough to retry alone.
 */
async function resolveMasterItems(templateId: string): Promise<MasterItem[]> {
  const supabase = createServiceClient({ system: 'inngest:platform-inventory-template-broadcast' })
    const items = await fetchAllRows<{
      catalog_item_id: string; par_level: number; preferred_brand: string | null; sort_order: number
    }>(
      (from, to) => supabase
        .from('platform_inventory_template_items')
        .select('catalog_item_id, par_level, preferred_brand, sort_order')
        .eq('platform_inventory_template_id', templateId)
        .order('sort_order')
        .order('catalog_item_id')
        .range(from, to),
      { label: 'platform-inventory-broadcast.master-items' },
    )
    if (!items.length) return []

    // Nullability matches the live schema: name, category and default_unit
    // are all NOT NULL on inventory_catalog (default_unit NOT NULL DEFAULT
    // 'units').
    const catalogRows = await fetchAllRows<{
      id: string; name: string; category: string; default_unit: string
    }>(
      (from, to) => supabase
        .from('inventory_catalog')
        .select('id, name, category, default_unit')
        .in('id', items.map((i) => i.catalog_item_id))
        .order('id')
        .range(from, to),
      { label: 'platform-inventory-broadcast.catalog' },
    )
    const catalogById = new Map(catalogRows.map((c) => [c.id, c]))

    const merged: MasterItem[] = []
    for (const item of items) {
      const catalog = catalogById.get(item.catalog_item_id)
      if (!catalog) continue   // catalog item deactivated/removed since — nothing to seed for new orgs
      merged.push({
        catalog_item_id: item.catalog_item_id,
        par_level:       item.par_level,
        preferred_brand: item.preferred_brand,
        sort_order:      item.sort_order,
        name:            catalog.name,
        category:        catalog.category,
        unit:            catalog.default_unit,
      })
    }
    return merged
}

export const broadcastPlatformInventoryTemplate = inngest.createFunction(
  {
    id:      'platform-inventory-template-broadcast',
    name:    'Broadcast Platform Inventory Template',
    retries: 3,
  },
  { event: 'platform_inventory_template/broadcast_requested' },
  async ({ event, step, logger }) => {
    const { platform_template_id: templateId, target_org_ids: targetOrgIds } = event.data

    const template = await step.run('fetch-template', async () => {
      const supabase = createServiceClient({ system: 'inngest:platform-inventory-template-broadcast' })
      // Unwrapped, not `const { data }`: a read failure here used to return
      // null, which the caller below reports as `template_not_found` — a
      // success-shaped result that cancels the entire broadcast.
      const res = await supabase
        .from('platform_inventory_templates')
        .select('id, name, description')
        .eq('id', templateId)
        .maybeSingle()
      return unwrap(res, { site: 'inngest.platform-inventory-broadcast.fetch-template' })
    })

    if (!template) {
      logger.warn(`[platform-inventory-template-broadcast] template ${templateId} not found — skipping`)
      return { synced_orgs: 0, reason: 'template_not_found' }
    }

    const masterItems = await step.run('fetch-master-items', () => resolveMasterItems(templateId))

    if (!masterItems.length) {
      logger.warn(`[platform-inventory-template-broadcast] template ${templateId} has no items — skipping`)
      return { synced_orgs: 0, reason: 'no_items' }
    }

    const orgIds = await step.run('fetch-target-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:platform-inventory-template-broadcast' })
      if (targetOrgIds) {
        // Paginated like the untargeted branch below: targetOrgIds is
        // caller-supplied and a broadcast to every tenant is exactly the case
        // that reaches the cap.
        const data = await fetchAllRows<{ id: string }>(
          (from, to) => supabase.from('organizations').select('id')
            .in('id', targetOrgIds).order('id').range(from, to),
          { label: 'platform-inventory-broadcast.targetOrgs' },
        )
        return data.map((o) => o.id)
      }
      // Was a hand-rolled pagination loop with `const { data }` and
      // `if (!data?.length) break` — so a read error on page 2 was
      // indistinguishable from "no more orgs" and silently broadcast to a
      // PREFIX of the platform while reporting total_orgs as complete. The
      // targeted branch six lines up already used fetchAllRows, which drains
      // .range() pages and throws on a page error; both branches now do.
      const rows = await fetchAllRows<{ id: string }>(
        (from, to) => supabase.from('organizations').select('id').order('id').range(from, to),
        { label: 'platform-inventory-broadcast.allOrgs' },
      )
      return rows.map((o) => o.id)
    })

    // Fan out one EVENT per org instead of one step.run per org.
    //
    // This loop used to be `for (const orgId of orgIds) { await step.run(...) }`
    // inside this single invocation — the only platform cron still doing that,
    // after the 2026-07-30 pass converted six others. Sequential steps in one
    // run means a broadcast to thousands of tenants accumulates thousands of
    // steps against Inngest's per-run step and duration ceilings, fails
    // partway through, and — with no per-org retry boundary — never syncs any
    // org after the failure point. Paginating orgIds correctly (which this
    // already did) fixes the READ and leaves the fan-out unbounded.
    //
    // step.sendEvent is itself one step regardless of how many events it
    // carries, so run length is now constant in tenant count. Each org gets
    // its own invocation, its own retry envelope, and its own timeout, and
    // syncInventoryTemplateForOrg's `concurrency` caps how many run at once.
    if (orgIds.length) {
      await step.sendEvent(
        'dispatch-org-syncs',
        orgIds.map((orgId) => ({
          name: 'inventory_template/sync_org.requested' as const,
          data: { org_id: orgId, platform_template_id: templateId },
        })),
      )
    }

    logger.info(
      `[platform-inventory-template-broadcast] dispatched ${orgIds.length} org(s) for template ${templateId}`
    )

    return { dispatched: orgIds.length, total_orgs: orgIds.length }
  }
)

/**
 * Per-org leg of the broadcast. One invocation = one tenant.
 *
 * Re-resolves the template and its master items rather than receiving them on
 * the event: the payload stays two ids instead of a ~115-item array repeated
 * across every org, and the handler is self-contained enough to retry on its
 * own. Same trade the capex pair makes with asset_type_standards.
 */
export const syncInventoryTemplateForOrg = inngest.createFunction(
  {
    id:          'sync-inventory-template-for-org',
    name:        'Inventory Template Broadcast — per org',
    retries:     3,
    // Caps platform-wide fan-out rate. Without it a broadcast to thousands of
    // orgs would try to run thousands of invocations at once against Supabase.
    concurrency: { limit: 10 },
  },
  { event: 'inventory_template/sync_org.requested' },
  async ({ event, step, logger }) => {
    const { org_id: orgId, platform_template_id: templateId } = event.data

    const template = await step.run('fetch-template', async () => {
      const supabase = createServiceClient({ system: 'inngest:sync-inventory-template-for-org' })
      const res = await supabase
        .from('platform_inventory_templates')
        .select('id, name, description')
        .eq('id', templateId)
        .maybeSingle()
      return unwrap(res, { site: 'inngest.sync-inventory-template-for-org.fetch-template', orgId })
    })

    if (!template) {
      // Deleted between dispatch and here. Not an error — nothing to sync.
      logger.warn(`[sync-inventory-template-for-org] template ${templateId} not found — skipping org ${orgId}`)
      return { org_id: orgId, items_added: 0, reason: 'template_not_found' as const }
    }

    const masterItems = await step.run('fetch-master-items', () => resolveMasterItems(templateId))

    if (!masterItems.length) {
      return { org_id: orgId, items_added: 0, reason: 'no_items' as const }
    }

    const itemsAdded = await step.run('sync-org', async () => {
      const supabase = createServiceClient({ system: 'inngest:platform-inventory-template-broadcast' })

      const existingTemplateRes = await supabase
        .from('inventory_templates')
        .select('id')
        .eq('org_id', orgId)
        .eq('source_platform_template_id', templateId)
        .maybeSingle()

      const existingTemplate = unwrap(existingTemplateRes, {
        site: 'inngest.platform-inventory-broadcast.existing-template', orgId,
      })

      let orgTemplateId = existingTemplate?.id
      if (!orgTemplateId) {
        const { data: created, error: createError } = await supabase
          .from('inventory_templates')
          .insert({
            org_id:                      orgId,
            name:                        template.name,
            description:                 template.description,
            source_platform_template_id: templateId,
          })
          .select('id')
          .single()
        // Was `logger.error(...); return 0`. A caught-and-returned error
        // inside step.run marks the step COMPLETE and memoizes the 0, so
        // Inngest never retries it — `retries: 3` on this function was inert
        // for both write paths — and the org silently drops out of a
        // broadcast whose final return still reports a healthy synced count.
        // Throwing re-runs only this org's step; the orgs already synced in
        // this run replay from memoized state.
        if (createError || !created) {
          throw new Error(
            `[platform-inventory-template-broadcast] failed to create org template for ${orgId}: ${createError?.message ?? 'no row returned'}`
          )
        }
        orgTemplateId = created.id
      }

      // This read IS the dedup — `toAdd` is the master list minus whatever
      // it returns. Discarding its error produced an empty Set, i.e. "this
      // org has nothing yet", which re-inserts the entire master list. There
      // was no unique index behind it either, so nothing downstream could
      // refuse the duplicates; 20260808060000 adds one, and this stops
      // relying on it.
      // Paginated, not .limit()'d, and that distinction is the whole point:
      // a TRUNCATED dedup set is the same defect as an empty one, just
      // smaller — the items past the cap look missing and get re-inserted.
      // inventory_template_items has no org_id (it is scoped through
      // template_id), so fetchAllRows is the bound available here, and it is
      // the same one the master-items read at the top of this function uses.
      const existingItems = await fetchAllRows<{ catalog_item_id: string | null }>(
        (from, to) => supabase
          .from('inventory_template_items')
          .select('catalog_item_id')
          .eq('template_id', orgTemplateId!)
          .order('id')
          .range(from, to),
        { label: 'platform-inventory-broadcast.existing-items' },
      )
      const existingCatalogItemIds = new Set(existingItems.map((i) => i.catalog_item_id))

      const toAdd = masterItems.filter((m) => !existingCatalogItemIds.has(m.catalog_item_id))
      if (!toAdd.length) return 0

      const { error: insertError } = await supabase
        .from('inventory_template_items')
        .insert(
          toAdd.map((item) => ({
            template_id:     orgTemplateId,
            catalog_item_id: item.catalog_item_id,
            name:            item.name,
            category:        item.category,
            unit:            item.unit,
            par_level:       item.par_level,
            preferred_brand: item.preferred_brand,
            sort_order:      item.sort_order,
          }))
        )
      if (insertError) {
        throw new Error(
          `[platform-inventory-template-broadcast] failed to insert items for org ${orgId}: ${insertError.message}`
        )
      }
      return toAdd.length
    })

    if (itemsAdded > 0) {
      await step.run('log-audit', async () => {
        await logAuditEvents([{
          orgId,
          action:     'platform_admin.inventory_template.broadcast_synced' as const,
          targetType: 'inventory_templates',
          metadata:   { platform_template_id: templateId, items_added: itemsAdded },
        }])
      })
    }

    return { org_id: orgId, items_added: itemsAdded }
  }
)
