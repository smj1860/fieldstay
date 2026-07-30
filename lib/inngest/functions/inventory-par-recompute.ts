/**
 * Re-resolves inventory_items.par_level for every 'smart' item in scope,
 * whenever property metadata, item config, or consumption stats change.
 * Fans out one step.run per property — same shape as
 * platform-inventory-template-broadcast.ts — so a run covering many
 * properties retries per-property, not from the top.
 *
 * par_mode = 'static' items are never touched: the fetch itself filters
 * `.eq('par_mode', 'smart')`, so a static row can never appear in the
 * update set.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents }      from '@/lib/audit'
import { resolvePar, type ParItemConfig, type ParPropertyContext, type ParConsumptionStats } from '@/lib/inventory/par-engine'

interface PropertyRow {
  id:              string
  bathrooms:       number | null
  bedrooms:        number
  max_guests:      number
  avg_stay_length: number | null
}

interface SmartItemRow {
  id:          string
  par_level:   number
  par_mode:    'static' | 'smart'
  smart_group: 'bathroom_essential' | 'bedroom_essential' | 'guest_consumable' | null
  base_qty:    number
  auto_adjust: boolean
}

interface StatsRow {
  inventory_item_id:        string
  avg_rate_per_guest_night: number
  sample_count:             number
}

export const recomputeInventoryParLevels = inngest.createFunction(
  {
    id:       'inventory-par-recompute',
    name:     'Recompute Dynamic Par Levels',
    retries:  3,
    // KNOWN GAP: keyed on property_id only, not org_id. Every call site wired
    // in pass 2 (property update, template apply, consumption-recorded's
    // re-trigger) always supplies property_id, so this is safe today. If a
    // future pass sends an org-wide recompute (property_id omitted) for
    // admin-driven default changes, Inngest debounce replaces the triggering
    // event with the latest one sharing the same key — two different orgs'
    // org-wide events would collide (same undefined property_id) and one
    // org's recompute would be silently dropped. Scope the key to org_id too
    // before wiring any property_id-omitted send.
    debounce: { key: 'event.data.property_id', period: '30s' },
  },
  { event: 'inventory/par-recompute-requested' as const },
  async ({ event, step }) => {
    const { org_id, property_id, inventory_item_ids } = event.data

    const properties = await step.run('fetch-scope', async () => {
      const supabase = createServiceClient({ system: 'inngest:inventory-par-recompute' })
      let query = supabase
        .from('properties')
        .select('id, bathrooms, bedrooms, max_guests, avg_stay_length')
        .eq('org_id', org_id)
      if (property_id) query = query.eq('id', property_id)
      const { data } = await query
      return (data ?? []) as PropertyRow[]
    })

    let itemsChanged = 0
    const auditEntries: { propertyId: string; itemsChanged: number }[] = []

    for (const property of properties) {
      const changedCount = await step.run(`recompute-${property.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:inventory-par-recompute' })

        // The .eq('par_mode', 'smart') filter is the static-item guarantee —
        // never remove it. Static rows must never enter the update set.
        let itemQuery = supabase
          .from('inventory_items')
          .select('id, par_level, par_mode, smart_group, base_qty, auto_adjust')
          .eq('org_id', org_id)
          .eq('property_id', property.id)
          .eq('is_active', true)
          .eq('par_mode', 'smart')
        if (inventory_item_ids?.length) itemQuery = itemQuery.in('id', inventory_item_ids)
        const { data: smartItems } = await itemQuery
        const typedItems = (smartItems ?? []) as SmartItemRow[]
        if (!typedItems.length) return 0

        const { data: statsRows } = await supabase
          .from('inventory_consumption_stats')
          .select('inventory_item_id, avg_rate_per_guest_night, sample_count')
          .eq('org_id', org_id)
          .eq('property_id', property.id)
          .in('inventory_item_id', typedItems.map((i) => i.id))
        const statsByItemId = new Map(
          ((statsRows ?? []) as StatsRow[]).map((s) => [s.inventory_item_id, s])
        )

        const propertyContext: ParPropertyContext = {
          bathrooms:       property.bathrooms,
          bedrooms:        property.bedrooms,
          max_guests:      property.max_guests,
          avg_stay_length: property.avg_stay_length,
        }

        const resolvedAt = new Date().toISOString()
        const changedRows: Array<{ id: string; par_level: number; par_resolved_at: string }> = []

        for (const item of typedItems) {
          const config: ParItemConfig = {
            par_mode:    item.par_mode,
            smart_group: item.smart_group,
            base_qty:    item.base_qty,
            par_level:   item.par_level,
            auto_adjust: item.auto_adjust,
          }
          const statsRow = statsByItemId.get(item.id)
          const stats: ParConsumptionStats | null = statsRow
            ? { avg_rate_per_guest_night: statsRow.avg_rate_per_guest_night, sample_count: statsRow.sample_count }
            : null

          const { par: resolved } = resolvePar(config, propertyContext, stats)
          if (resolved !== item.par_level) {
            changedRows.push({ id: item.id, par_level: resolved, par_resolved_at: resolvedAt })
          }
        }

        if (!changedRows.length) return 0

        // 1 query: bulk upsert resolved par levels (replaces N sequential UPDATEs)
        await supabase
          .from('inventory_items')
          .upsert(changedRows, { onConflict: 'id' })

        return changedRows.length
      })

      if (changedCount > 0) {
        itemsChanged += changedCount
        auditEntries.push({ propertyId: property.id, itemsChanged: changedCount })
      }
    }

    if (auditEntries.length) {
      await step.run('log-audit', async () => {
        await logAuditEvents(
          auditEntries.map((entry) => ({
            orgId:      org_id,
            action:     'inventory.par.recomputed' as const,
            targetType: 'property',
            targetId:   entry.propertyId,
            metadata:   { items_changed: entry.itemsChanged },
          }))
        )
      })
    }

    return { properties_processed: properties.length, items_changed: itemsChanged }
  }
)
