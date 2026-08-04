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

interface MasterItem {
  catalog_item_id: string
  par_level:       number
  preferred_brand: string | null
  sort_order:      number
  name:            string
  category:        string
  unit:            string
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
      const { data } = await supabase
        .from('platform_inventory_templates')
        .select('id, name, description')
        .eq('id', templateId)
        .maybeSingle()
      return data
    })

    if (!template) {
      logger.warn(`[platform-inventory-template-broadcast] template ${templateId} not found — skipping`)
      return { synced_orgs: 0, reason: 'template_not_found' }
    }

    const masterItems = await step.run('fetch-master-items', async () => {
      const supabase = createServiceClient({ system: 'inngest:platform-inventory-template-broadcast' })
      const { data: items } = await supabase
        .from('platform_inventory_template_items')
        .select('catalog_item_id, par_level, preferred_brand, sort_order')
        .eq('platform_inventory_template_id', templateId)
      if (!items?.length) return []

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
    })

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
      const pageSize = 1000
      const all: string[] = []
      for (let from = 0; ; from += pageSize) {
        const { data } = await supabase.from('organizations').select('id').range(from, from + pageSize - 1)
        if (!data?.length) break
        all.push(...data.map((o) => o.id))
        if (data.length < pageSize) break
      }
      return all
    })

    let syncedOrgs = 0
    const auditEntries: { orgId: string; itemsAdded: number }[] = []

    for (const orgId of orgIds) {
      const itemsAdded = await step.run(`sync-org-${orgId}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:platform-inventory-template-broadcast' })

        const { data: existingTemplate } = await supabase
          .from('inventory_templates')
          .select('id')
          .eq('org_id', orgId)
          .eq('source_platform_template_id', templateId)
          .maybeSingle()

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
          if (createError || !created) {
            logger.error(`[platform-inventory-template-broadcast] failed to create org template for ${orgId}`, createError)
            return 0
          }
          orgTemplateId = created.id
        }

        const { data: existingItems } = await supabase
          .from('inventory_template_items')
          .select('catalog_item_id')
          .eq('template_id', orgTemplateId)
        const existingCatalogItemIds = new Set((existingItems ?? []).map((i) => i.catalog_item_id))

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
          logger.error(`[platform-inventory-template-broadcast] failed to insert items for org ${orgId}`, insertError)
          return 0
        }
        return toAdd.length
      })

      if (itemsAdded > 0) {
        syncedOrgs++
        auditEntries.push({ orgId, itemsAdded })
      }
    }

    await step.run('log-audit', async () => {
      if (!auditEntries.length) return
      await logAuditEvents(
        auditEntries.map((entry) => ({
          orgId:      entry.orgId,
          action:     'platform_admin.inventory_template.broadcast_synced' as const,
          targetType: 'inventory_templates',
          metadata:   { platform_template_id: templateId, items_added: entry.itemsAdded },
        }))
      )
    })

    return { synced_orgs: syncedOrgs, total_orgs: orgIds.length }
  }
)
