// lib/dexie/sync/assets.ts
//
// Derives this crew member's currently-assigned property set and pulls
// property_assets for it into Dexie. Extracted out of DexieProvider's mount
// effect (lib/dexie/context.tsx).

import type { DexieSupabaseClient } from './types'
import { getDexieDb, type PropertyAssetRow } from '../schema'

// Properties this crew member currently has a stake in — same derivation as
// assignedPropertyIds in app/crew/page.tsx (active turnovers ∪ assigned work
// orders) — backs the Assets & Maintenance page's per-property missing-items
// list.
export async function computeAssignedPropertyIds(userId: string): Promise<string[]> {
  const db = getDexieDb(userId)
  const [turnoverRows, woRows] = await Promise.all([
    db.turnovers.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').toArray(),
    db.crew_work_orders.filter((wo) => wo.status !== 'completed' && wo.status !== 'cancelled').toArray(),
  ])
  const ids = new Set<string>([
    ...turnoverRows.map((t) => t.property_id),
    ...woRows.map((w) => w.property_id),
  ])
  return [...ids]
}

export async function syncPropertyAssets(
  supabase: DexieSupabaseClient,
  userId: string,
  propertyIds: string[],
): Promise<void> {
  if (!propertyIds.length) return
  const db = getDexieDb(userId)

  const { data: assets, error } = await supabase
    .from('property_assets')
    .select('id, org_id, property_id, asset_type, make, model, is_na, photo_url')
    .in('property_id', propertyIds)
    .eq('is_active', true)
  if (error) {
    console.error('[asset sync] property_assets fetch failed:', error)
    return
  }

  if (assets?.length) {
    const normalized = assets.map((a: Record<string, unknown>) => ({
      ...a,
      make:      a.make ?? '',
      model:     a.model ?? '',
      is_na:     a.is_na ? 1 : 0,
      photo_url: a.photo_url ?? '',
    }))
    await db.property_assets.bulkPut(normalized as PropertyAssetRow[])
  }
}
