import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { unwrapList } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import {
  resolvePar,
  type ParPropertyContext,
  type ParItemConfig,
  type ParConsumptionStats,
  type ParMode,
  type ParSmartGroup,
} from './par-engine'

/**
 * PAR pass 2, read+resolve side: recompute every smart item's par_level for an
 * org (or one property) and write the results back.
 *
 * This is what makes a smart par actually mean something. Until it runs, an
 * item applied from the standard template carries the TEMPLATE's default — the
 * number computed against a generic reference property — so a studio and a
 * six-bedroom lodge both show 14 bath towels. resolvePar() turns base_qty into
 * a real number using the property's own bedrooms / bathrooms / max_guests,
 * and its historical consumption once enough samples exist.
 *
 * SET-BASED, not per-property. Three bounded reads for the whole scope, one
 * RPC to write. The obvious shape — loop properties, query each — is the N+1
 * that unit/guardrails/n-plus-one-loops.test.ts exists to catch, and a
 * 50-property portfolio would make thousands of round trips per recompute.
 */

const PROPERTY_CAP = 1000
const ITEM_CAP     = 20_000

interface PropertyRow {
  id:              string
  bedrooms:        number | null
  bathrooms:       number | null
  max_guests:      number | null
  avg_stay_length: number | null
}

interface ItemRow {
  id:          string
  property_id: string
  par_mode:    ParMode
  smart_group: ParSmartGroup | null
  base_qty:    number
  par_level:   number
  auto_adjust: boolean
}

interface StatsRow {
  inventory_item_id:        string
  avg_rate_per_guest_night: number
  sample_count:             number
}

export interface RecomputeResult {
  properties: number
  resolved:   number
  changed:    number
}

/**
 * resolvePar's context requires non-null bedrooms/max_guests. Every one of
 * these columns is nullable in the DB and several are 0 on live rows, so the
 * coercion happens HERE rather than being pushed into the engine: the engine
 * stays a pure function of well-formed input, and the "what does a property
 * with no metadata mean" decision lives in one visible place.
 *
 * A 0 or null is treated as unknown, not as literally zero — a property whose
 * bedroom count nobody filled in still needs towels. The engine's own
 * multiplier guard (`raw > 0 ? raw : 1`) is the second line of defence.
 */
function toPropertyContext(p: PropertyRow): ParPropertyContext {
  return {
    bedrooms:        p.bedrooms  && p.bedrooms  > 0 ? p.bedrooms  : 1,
    bathrooms:       p.bathrooms && p.bathrooms > 0 ? p.bathrooms : 1,
    max_guests:      p.max_guests && p.max_guests > 0 ? p.max_guests : 2,
    avg_stay_length: p.avg_stay_length,
  }
}

export async function recomputeParLevels(
  supabase: SupabaseClient,
  scope: { orgId: string; propertyId?: string },
): Promise<RecomputeResult> {
  const { orgId, propertyId } = scope
  const ctx = { site: 'lib.inventory.recomputeParLevels', orgId }

  const properties = await fetchAllRows<PropertyRow>(
    (from, to) => {
      const q = supabase
        .from('properties')
        .select('id, bedrooms, bathrooms, max_guests, avg_stay_length')
        .eq('org_id', orgId)
        .eq('is_active', true)
      // Built conditionally rather than with .modify(), which is not a real
      // method on the Supabase client.
      const scoped = propertyId ? q.eq('id', propertyId) : q
      return scoped.order('id').range(from, to)
    },
    { label: 'inventory.recomputePar.properties', maxRows: PROPERTY_CAP },
  )
  if (!properties.length) return { properties: 0, resolved: 0, changed: 0 }

  const propertyIds = properties.map((p) => p.id)

  // Only smart rows. A static item's par_level is the PM's manual number and
  // must never be overwritten by a recompute — that is the entire meaning of
  // par_mode = 'static'.
  const items = await fetchAllRows<ItemRow>(
    (from, to) => supabase
      .from('inventory_items')
      .select('id, property_id, par_mode, smart_group, base_qty, par_level, auto_adjust')
      .eq('org_id', orgId)
      .eq('par_mode', 'smart')
      .in('property_id', propertyIds)
      .order('id')
      .range(from, to),
    { label: 'inventory.recomputePar.items', maxRows: ITEM_CAP },
  )
  if (!items.length) return { properties: properties.length, resolved: 0, changed: 0 }

  // Empty today (the consumption recorder is the next piece), so every item
  // currently resolves through the smart-group formula. Reading it now means
  // the historical branch starts working the moment stats exist, with no
  // further change here.
  const statsRes = await supabase
    .from('inventory_consumption_stats')
    .select('inventory_item_id, avg_rate_per_guest_night, sample_count')
    .eq('org_id', orgId)
    .in('inventory_item_id', items.map((i) => i.id))
    .limit(ITEM_CAP)
  const stats = unwrapList<StatsRow>(statsRes, { ...ctx, extra: { stage: 'stats' } })

  const propertyById = new Map(properties.map((p) => [p.id, toPropertyContext(p)]))
  const statsByItem   = new Map(stats.map((s) => [s.inventory_item_id, s]))

  const rows: { id: string; par_level: number }[] = []
  for (const item of items) {
    const property = propertyById.get(item.property_id)
    if (!property) continue

    const config: ParItemConfig = {
      par_mode:    item.par_mode,
      smart_group: item.smart_group,
      base_qty:    Number(item.base_qty),
      par_level:   Number(item.par_level),
      auto_adjust: item.auto_adjust,
    }
    const s = statsByItem.get(item.id)
    const consumption: ParConsumptionStats | null = s
      ? { avg_rate_per_guest_night: Number(s.avg_rate_per_guest_night), sample_count: s.sample_count }
      : null

    const { par } = resolvePar(config, property, consumption)
    rows.push({ id: item.id, par_level: par })
  }

  if (!rows.length) return { properties: properties.length, resolved: 0, changed: 0 }

  // One statement for the whole batch. See 20260811130000 for why this is an
  // RPC and not an .upsert().
  const { data, error } = await supabase.rpc('apply_resolved_par_levels', { p_rows: rows })
  if (error) throw error

  return { properties: properties.length, resolved: rows.length, changed: Number(data ?? 0) }
}
