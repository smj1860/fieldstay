'use client'

// lib/dexie/dashboard/inspection-sync.ts
//
// Filling the local cache for ONE inspection, so the fill screen can render
// with no connection.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FILL SCREEN DOES NOT SERVER-RENDER ITS DATA
//
// public/sw.js states the condition for /maintenance joining the offline
// allowlist, and it is not "the local store exists":
//
//   "What this worker caches is the SERVER-RENDERED HTML of a page.
//    /maintenance is a Server Component that renders its data on the server, so
//    serving it from cache serves last Tuesday's board no matter how current
//    the IndexedDB copy beside it is. […] /maintenance goes in when it renders
//    from the local cache, not when the local cache exists."
//
// So the route's Server Component renders a SHELL — ids and nothing else — and
// everything with a value in it comes from Dexie. Cached HTML is then a frame,
// which cannot go stale, and the data beside it is whatever the device last
// pulled.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PULL FAILURE IS NOT AN ERROR
//
// This runs on a tablet at a property. Offline is the expected state, not the
// exceptional one, and the whole point of the cache is that a failed pull
// changes nothing about whether the inspector can work. A pull returns a
// DISCRIMINATED result rather than throwing, and the screen only shows anything
// when the cache is ALSO empty — which is the one case where the walk genuinely
// cannot start.

import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/observability/report-error'
import type { Inspection, PropertyAsset } from '@/types/database'

import { getDashboardDb } from './schema'

export type PullOutcome =
  | { ok: true }
  /** No connection. Expected at a property; the cache carries the screen. */
  | { ok: false; reason: 'offline' }
  /** The row is gone, or belongs to another org. Distinct from "not cached". */
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'error' }

/**
 * Pulls one inspection and the assets its form resolution depends on.
 *
 * The assets matter as much as the inspection: §12.3's section gates and the
 * per-asset sweep are both driven by `property_assets`, so a device with the
 * inspection but not the assets would render a DIFFERENT form — silently
 * dropping the well section on a property that has a well.
 */
export async function pullInspection(
  userId:       string,
  orgId:        string,
  inspectionId: string,
): Promise<PullOutcome> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' }
  }

  const supabase = createClient()

  try {
    const { data: inspection, error } = await supabase
      .from('inspections')
      .select('*')
      // org_id as well as id. RLS already scopes this, but a tenant filter that
      // depends only on RLS is one policy edit away from being no filter.
      .eq('org_id', orgId)
      .eq('id', inspectionId)
      .maybeSingle()

    if (error) {
      reportError(error, { site: 'dexie.dashboard.pullInspection' })
      return { ok: false, reason: 'error' }
    }
    if (!inspection) return { ok: false, reason: 'not_found' }
    // Cast at the boundary, once. The Supabase client omits the <Database>
    // generic repo-wide (see lib/supabase/server.ts), so every .from() is
    // untyped; asserting here rather than at each use keeps the untyped surface
    // to a single line instead of spreading it through the transaction.
    const row = inspection as unknown as Inspection

    const { data: assets, error: assetsError } = await supabase
      .from('property_assets')
      .select('*')
      .eq('org_id', orgId)
      .eq('property_id', row.property_id)
      .eq('is_active', true)
      // Bounded: one property's active assets, and asset_type_standards has 21
      // types — 100 is far above any real property and still an explicit
      // ceiling, because a truncated asset list resolves to a shorter form.
      .limit(100)

    if (assetsError) {
      reportError(assetsError, { site: 'dexie.dashboard.pullInspection.assets' })
      return { ok: false, reason: 'error' }
    }

    const activeAssets = (assets ?? []) as unknown as PropertyAsset[]

    const db = getDashboardDb(userId, orgId)
    await db.transaction('rw', db.inspections, db.property_assets, async () => {
      await db.inspections.put(row)

      // Reconciled by absence, scoped to THIS property. An asset retired since
      // the last pull must stop opening its section gate, and a plain bulkPut
      // would leave it there forever. Scoped to one property_id deliberately —
      // reconciling the whole table from a single-property fetch would delete
      // every other property's cached assets, which is the empty-set failure
      // `absence-reconciliation` exists to catch. Here the fetch cannot be
      // empty-by-error: an error returned above, before this block.
      const stale = await db.property_assets
        .where('property_id').equals(row.property_id)
        .primaryKeys()
      const keep = new Set(activeAssets.map((a) => a.id))
      await db.property_assets.bulkDelete(stale.filter((id) => !keep.has(id)))
      await db.property_assets.bulkPut(activeAssets)
    })

    return { ok: true }
  } catch (err) {
    // A fetch that rejects outright is almost always the network. Reported, but
    // it is not a reason to stop an inspector working from the cache.
    reportError(err, { site: 'dexie.dashboard.pullInspection' })
    return { ok: false, reason: 'offline' }
  }
}
