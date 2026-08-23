'use client'

// lib/dexie/dashboard/warm-inspections.ts
//
// Pre-caches every open inspection — its data AND its page — while the tablet
// still has signal, so a PM can drive to a property without having opened the
// inspection first.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FAILURE THIS EXISTS FOR
//
// Both halves of the fill screen were lazy, and each was independently fatal at
// the property:
//
//   THE PAGE. sw.js caches a document only when that exact URL has been
//   navigated to successfully. `/maintenance/inspections/<uuid>` has never been
//   visited until the PM taps it — which is the moment they are standing at the
//   house with no service, and the app answers with the offline page.
//
//   THE DATA. `pullInspection` runs on the fill screen's own mount. So even a
//   cached document would render "this inspection isn't on this device yet".
//
// Warming one without the other buys nothing, which is why this does both in
// one pass. It is the dashboard counterpart of lib/dexie/sync/warm-routes.ts
// and deliberately mirrors its rules: credentialed fetches (an uncredentialed
// one caches a login redirect, which is worse than caching nothing because it
// would then be SERVED at the house), never cache a redirect or an error, and
// never let a warm failure break the thing it was helping.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS CANNOT DO, AND IT IS NOT AN OVERSIGHT
//
// It cannot make an inspection STARTABLE offline. §8 settles that: `started_at`
// is a server clock because "a device clock is both skewable and, for an
// artifact whose entire value is being believed, the wrong thing to trust." An
// inspection has to exist before this can warm it.

import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/observability/report-error'
import { ROUTE_WARM_TIMEOUT_MS } from '@/lib/http/timeout'
import { SHELL_CACHE } from '@/lib/pwa/cache-names'
import type { Inspection, PropertyAsset } from '@/types/database'

import { getDashboardDb } from './schema'

/**
 * Ceiling on one warm pass.
 *
 * Each route is a real request for a server-rendered document. A PM running
 * inspections across a 50-property portfolio will not have more than a handful
 * open at once, so this is headroom rather than a guess — but it is an explicit
 * ceiling, because an unbounded pass over a year of stale open inspections
 * would be a request storm on every dashboard load.
 */
export const WARM_INSPECTION_LIMIT = 15

/** How often a warm is worth repeating. Cheap, but not free. */
const WARM_INTERVAL_MS = 15 * 60 * 1000

const WARM_WATERMARK = 'inspections:last_warm_at'

function canWarm(): boolean {
  if (typeof caches === 'undefined' || typeof fetch === 'undefined') return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  return true
}

export interface WarmResult {
  inspections: number
  routes:      number
  skipped?:    'offline' | 'throttled'
}

/**
 * Pulls every open inspection into the local cache and warms its page.
 *
 * Never throws. The data half is what makes the walk possible; the route half
 * only makes it reachable without a network, and a device that misses a warm is
 * no worse off than before this existed.
 */
export async function warmInspectionsForOffline(
  userId: string,
  orgId:  string,
  opts:   { force?: boolean } = {},
): Promise<WarmResult> {
  if (!canWarm()) return { inspections: 0, routes: 0, skipped: 'offline' }

  const db = getDashboardDb(userId, orgId)

  try {
    if (!opts.force && !(await isDue(db, WARM_INTERVAL_MS))) {
      return { inspections: 0, routes: 0, skipped: 'throttled' }
    }

    const inspections = await fetchOpenInspections(orgId)
    if (inspections === null) return { inspections: 0, routes: 0 }

    // Stamped even when there is nothing to warm. An org with no open
    // inspections would otherwise re-run the query on every dashboard mount
    // forever, which is the case where the throttle matters most.
    await db.sync_meta.put({ key: WARM_WATERMARK, value: new Date().toISOString() })
    if (inspections.length === 0) return { inspections: 0, routes: 0 }

    await cacheInspectionsAndAssets(db, orgId, inspections)
    const routes = await warmRoutes(inspections.map((i) => `/maintenance/inspections/${i.id}`))

    return { inspections: inspections.length, routes }
  } catch (err) {
    console.warn('[warmInspections] warm failed (non-fatal):', err)
    return { inspections: 0, routes: 0 }
  }
}

async function isDue(
  db: ReturnType<typeof getDashboardDb>,
  intervalMs: number,
): Promise<boolean> {
  const row = await db.sync_meta.get(WARM_WATERMARK)
  if (!row?.value) return true
  const last = Date.parse(row.value)
  // An unparseable watermark is treated as "never warmed" rather than "warmed
  // at NaN", which would compare false forever and disable warming silently.
  return Number.isNaN(last) || Date.now() - last >= intervalMs
}

/** Open inspections for this org. `null` means the query FAILED, not that there are none. */
async function fetchOpenInspections(orgId: string): Promise<Inspection[] | null> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('inspections')
    .select('*')
    .eq('org_id', orgId)
    .is('completed_at', null)
    // Newest first, so a portfolio with more open inspections than the ceiling
    // warms the ones a PM is most likely to be driving to.
    .order('started_at', { ascending: false })
    .limit(WARM_INSPECTION_LIMIT)

  if (error) {
    reportError(error, { site: 'dexie.dashboard.warmInspections' })
    return null
  }
  return (data ?? []) as unknown as Inspection[]
}

/**
 * The inspection rows and the assets their form resolution depends on.
 *
 * The assets matter as much as the inspection: §12.3's section gates and the
 * per-unit questions are both driven by `property_assets`, so a device holding
 * the inspection but not the assets renders a DIFFERENT form — silently
 * dropping the well section on a property that has a well, or asking about one
 * refrigerator where there are two.
 */
async function cacheInspectionsAndAssets(
  db: ReturnType<typeof getDashboardDb>,
  orgId: string,
  inspections: Inspection[],
): Promise<void> {
  const propertyIds = [...new Set(inspections.map((i) => i.property_id))]

  const supabase = createClient()
  const { data: assets, error } = await supabase
    .from('property_assets')
    .select('*')
    .eq('org_id', orgId)
    .in('property_id', propertyIds)
    .eq('is_active', true)
    // One query for every property rather than one per property — the N+1 this
    // repo has a guardrail about. Bounded by properties × ~21 asset types.
    .limit(WARM_INSPECTION_LIMIT * 100)

  if (error) {
    reportError(error, { site: 'dexie.dashboard.warmInspections.assets' })
    // The inspections are still worth caching without the assets: the fill
    // screen renders, and its own pull corrects the asset set on open.
    await db.inspections.bulkPut(inspections)
    return
  }

  const active = (assets ?? []) as unknown as PropertyAsset[]

  await db.transaction('rw', db.inspections, db.property_assets, async () => {
    await db.inspections.bulkPut(inspections)

    // Reconciled by absence, scoped to the properties this fetch actually
    // covered. A retired asset must stop opening its section gate, and a plain
    // bulkPut would leave it there forever. Scoping to the fetched properties
    // is what stops an empty result deleting another property's cached assets —
    // and the fetch cannot be empty-by-error here, because an error returned
    // above before this block.
    const covered = new Set(propertyIds)
    const stale = await db.property_assets
      .filter((a) => covered.has(a.property_id))
      .primaryKeys()
    const keep = new Set(active.map((a) => a.id))
    await db.property_assets.bulkDelete(stale.filter((id) => !keep.has(id)))
    await db.property_assets.bulkPut(active)
  })
}

/** Fetches each page document and puts it in the shell cache. */
async function warmRoutes(routes: string[]): Promise<number> {
  const cache = await caches.open(SHELL_CACHE)

  let warmed = 0
  for (const route of routes) {
    try {
      // Same-origin credentialed: these pages are auth-gated, and an
      // uncredentialed fetch would cache a login redirect — worse than caching
      // nothing, because it would then be SERVED at the property.
      const res = await fetch(route, {
        credentials: 'same-origin',
        signal:      AbortSignal.timeout(ROUTE_WARM_TIMEOUT_MS),
      })

      // Only a real page. A 3xx to /login or a 5xx cached here is a trap that
      // outlives the outage that produced it.
      if (!res.ok || res.redirected) continue

      await cache.put(route, res.clone())
      warmed++
    } catch {
      // One route failing is not a reason to abandon the rest.
    }
  }
  return warmed
}
