// lib/dexie/sync/assets.ts
//
// Derives this crew member's currently-assigned property set and pulls
// property_assets for it into Dexie. Extracted out of DexieProvider's mount
// effect (lib/dexie/context.tsx).

import type { DexieSupabaseClient } from './types'
import { getDexieDb, type PropertyAssetRow } from '../schema'
import { fetchInChunksPaginated } from './chunked'
import { bulkPutShadowed } from './shadow'
import { reportError } from '@/lib/observability/report-error'

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

  // Paginated per chunk: this is a ONE-TO-MANY scope. Chunking property_ids
  // bounds the ID LIST, not the ROW COUNT — 100 properties fan out to every
  // active asset on each, so the request can ask for far more than PostgREST's
  // 1000-row cap and get a silent short page back. Same defect class as the
  // crew checklist truncation (see fetchInChunksPaginated); here it would mean
  // assets simply missing from a crew member's device.
  const assets = await fetchInChunksPaginated<string, Record<string, unknown>>(
    propertyIds,
    (chunk, from, to) =>
      supabase
        .from('property_assets')
        .select('id, org_id, property_id, asset_type, make, model, is_na, photo_url')
        .in('property_id', chunk)
        .eq('is_active', true)
        .order('id')
        .range(from, to),
  )
  if (assets === null) {
    console.error('[asset sync] property_assets fetch failed')
    reportError(new Error('property_assets fetch failed'), { site: 'dexie.sync.assets.property_assets' })
    return
  }

  if (assets.length) {
    const normalized = assets.map((a: Record<string, unknown>) => ({
      ...a,
      make:      a.make ?? '',
      model:     a.model ?? '',
      is_na:     a.is_na ? 1 : 0,
      photo_url: a.photo_url ?? '',
    }))
    await bulkPutShadowed(db.property_assets, userId, 'property_assets', normalized as PropertyAssetRow[])
  }
}
