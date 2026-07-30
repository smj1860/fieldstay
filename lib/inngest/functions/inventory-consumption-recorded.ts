/**
 * Records raw consumption samples derived from an inventory count (or count
 * draft approval), rolls them into inventory_consumption_stats, and kicks
 * off a par recompute for any touched item. This is the data feed the
 * historical branch of resolvePar() (par-engine.ts) depends on.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const recordInventoryConsumption = inngest.createFunction(
  {
    id:      'inventory-consumption-recorded',
    name:    'Record Inventory Consumption',
    retries: 3,
  },
  { event: 'inventory/consumption-recorded' as const },
  async ({ event, step }) => {
    const { org_id, property_id, source_type, source_id, samples } = event.data

    const { insertedCount, touchedItemIds } = await step.run('verify-and-insert-samples', async () => {
      const supabase = createServiceClient({ system: 'inngest:inventory-consumption-recorded' })

      // Verify the property belongs to this org before trusting anything
      // derived from it — a forged/mismatched property_id must never let
      // one org read or write another org's consumption data.
      const { data: property } = await supabase
        .from('properties')
        .select('id, max_guests, avg_stay_length')
        .eq('id', property_id)
        .eq('org_id', org_id)
        .maybeSingle()

      if (!property) return { insertedCount: 0, touchedItemIds: [] as string[] }

      // Never trust event-supplied item ids — verify every sample's
      // inventory_item_id belongs to this org AND this property before
      // writing anything derived from it.
      const { data: verifiedItems } = await supabase
        .from('inventory_items')
        .select('id')
        .eq('org_id', org_id)
        .eq('property_id', property_id)
        .in('id', samples.map((s) => s.inventory_item_id))
      const verifiedIds = new Set((verifiedItems ?? []).map((i) => i.id))
      const orgScopedSamples = samples.filter((s) => verifiedIds.has(s.inventory_item_id))

      if (!orgScopedSamples.length) return { insertedCount: 0, touchedItemIds: [] as string[] }

      // Guest-night proxy — bookings carry no guest_count yet; the same
      // proxy is used at resolve time (par-engine historicalPar), so the
      // normalization cancels consistently. Pass 4 upgrades both sides to
      // booking actuals together.
      const guestNights = Math.max(property.max_guests, 1) * Math.max(property.avg_stay_length ?? 3, 1)

      const rows = orgScopedSamples.map((s) => ({
        org_id,
        property_id,
        inventory_item_id:    s.inventory_item_id,
        source_type,
        source_id,
        consumed_qty:         s.consumed_qty,
        rate_per_guest_night: s.consumed_qty / guestNights,
      }))

      // Idempotency guard — an Inngest retry or a double-fired event
      // re-inserting the same (source_type, source_id, inventory_item_id)
      // is dropped rather than duplicated.
      const { error } = await supabase
        .from('inventory_consumption_samples')
        .upsert(rows, { onConflict: 'source_type,source_id,inventory_item_id', ignoreDuplicates: true })

      if (error) throw error

      return { insertedCount: rows.length, touchedItemIds: orgScopedSamples.map((s) => s.inventory_item_id) }
    })

    if (insertedCount === 0) {
      return { inserted: 0 }
    }

    await step.run('recompute-stats', async () => {
      const supabase = createServiceClient({ system: 'inngest:inventory-consumption-recorded' })

      for (const itemId of touchedItemIds) {
        // Recompute-from-samples (not incremental mutation) is what keeps
        // replays idempotent: the average is always derived fresh from the
        // most recent stored rows, never accumulated onto a running total,
        // so a duplicate/retried sample insert (already deduped above)
        // can't skew the stats even if this step itself re-runs.
        const { data: recentSamples } = await supabase
          .from('inventory_consumption_samples')
          .select('rate_per_guest_night, recorded_at')
          .eq('property_id', property_id)
          .eq('inventory_item_id', itemId)
          .order('recorded_at', { ascending: false })
          .limit(20)

        if (!recentSamples?.length) continue

        const avgRate = recentSamples.reduce((sum, s) => sum + s.rate_per_guest_night, 0) / recentSamples.length
        const lastSampleAt = recentSamples[0]!.recorded_at

        await supabase
          .from('inventory_consumption_stats')
          .upsert(
            {
              property_id,
              inventory_item_id:        itemId,
              org_id,
              avg_rate_per_guest_night: avgRate,
              sample_count:             recentSamples.length,
              last_sample_at:           lastSampleAt,
            },
            { onConflict: 'property_id,inventory_item_id' }
          )
      }
    })

    await step.sendEvent('send-par-recompute', {
      name: 'inventory/par-recompute-requested',
      data: { org_id, property_id, inventory_item_ids: touchedItemIds },
    })

    return { inserted: insertedCount, items_touched: touchedItemIds.length }
  }
)
