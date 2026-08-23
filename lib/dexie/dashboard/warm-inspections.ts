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
// IT ALSO WARMS THE FORM LIBRARY, SO A WALK CAN BEGIN OFFLINE
//
// Warming only the OPEN inspections left one hole: an inspection had to already
// exist to be warmed, so offline inspection worked exactly when somebody had
// remembered to create the row before leaving. §8's original reasoning — that
// `started_at` must be a server clock — was revised on 2026-08-23 (see
// 20260823053931) once it was clear the duration claim survives a device clock
// corrected by the skew measured at sync.
//
// So the whole form library and the property list come too. Measured against
// production that is 3 forms, 24 sections, 173 items at 38 kB, plus 29
// properties and 174 assets — cheaper than the single inspection this used to
// warm, and platform-owned data that changes only when we re-seed.

import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/observability/report-error'
import { ROUTE_WARM_TIMEOUT_MS } from '@/lib/http/timeout'
import { SHELL_CACHE } from '@/lib/pwa/cache-names'
import type {
  Inspection,
  InspectionForm,
  InspectionFormItem,
  InspectionFormSection,
  Property,
  PropertyAsset,
} from '@/types/database'

import { getDashboardDb, type OpenConcernRow } from './schema'

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
  /** Form ITEMS cached — the number that tells you a walk can start offline. */
  formItems:   number
  properties:  number
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
  if (!canWarm()) return { ...EMPTY, skipped: 'offline' }

  const db = getDashboardDb(userId, orgId)

  try {
    if (!opts.force && !(await isDue(db, WARM_INTERVAL_MS))) {
      return { ...EMPTY, skipped: 'throttled' }
    }

    // The library first, and independently of the rest: it is what makes a walk
    // STARTABLE offline, so it must land even for an org with no open
    // inspections at all — which is precisely the org about to start its first.
    const library = await cacheFormLibrary(db, orgId)

    const inspections = await fetchOpenInspections(orgId)
    if (inspections === null) return { ...EMPTY, ...library }

    // Stamped even when there is nothing further to warm. An org with no open
    // inspections would otherwise re-run every query on every dashboard mount,
    // which is the case where the throttle matters most.
    await db.sync_meta.put({ key: WARM_WATERMARK, value: new Date().toISOString() })
    if (inspections.length === 0) return { ...EMPTY, ...library }

    await cacheInspectionsAndAssets(db, orgId, inspections)
    await cacheOpenConcerns(db, orgId, [...new Set(inspections.map((i) => i.property_id))])
    const routes = await warmRoutes([
      // The START screen, so "new inspection" is reachable with no signal. It
      // is the one route here that is not per-inspection, and warming it is the
      // difference between a PM being able to begin a walk and being told they
      // are offline.
      '/maintenance/inspections',
      ...inspections.map((i) => `/maintenance/inspections/${i.id}`),
    ])

    return { ...EMPTY, ...library, inspections: inspections.length, routes }
  } catch (err) {
    console.warn('[warmInspections] warm failed (non-fatal):', err)
    return EMPTY
  }
}

const EMPTY: WarmResult = { inspections: 0, routes: 0, formItems: 0, properties: 0 }

/**
 * The platform form library and the org's properties.
 *
 * Both are needed BEFORE an inspection exists: the start screen has to offer a
 * property and a form, and the fill screen builds its own `form_snapshot` from
 * these rows when the walk begins with no signal.
 *
 * Never partially applied. Each table is reconciled only when its own fetch
 * succeeded, because a half-cached form — sections without their items — would
 * resolve to a SHORTER form rather than an obviously broken one.
 */
async function cacheFormLibrary(
  db:    ReturnType<typeof getDashboardDb>,
  orgId: string,
): Promise<{ formItems: number; properties: number }> {
  const supabase = createClient()

  const [forms, sections, items, properties] = await Promise.all([
    supabase.from('inspection_forms').select('*').eq('is_active', true).limit(50),
    supabase.from('inspection_form_sections').select('*').limit(500),
    // Bounded well above the live 173. A truncated item list is the dangerous
    // failure here: it renders as a form that is simply missing questions.
    supabase.from('inspection_form_items').select('*').limit(5000),
    supabase.from('properties').select('*').eq('org_id', orgId).order('name').limit(500),
  ])

  const failed = [forms, sections, items, properties].find((r) => r.error)
  if (failed?.error) {
    reportError(failed.error, { site: 'dexie.dashboard.warmInspections.library' })
    return { formItems: 0, properties: 0 }
  }

  const formRows     = (forms.data      ?? []) as unknown as InspectionForm[]
  const sectionRows  = (sections.data   ?? []) as unknown as InspectionFormSection[]
  const itemRows     = (items.data      ?? []) as unknown as InspectionFormItem[]
  const propertyRows = (properties.data ?? []) as unknown as Property[]

  // An empty form library means the seed has not run, NOT that the forms were
  // deleted. Replacing a good cache with nothing would take a device that could
  // start a walk and make it unable to — the empty-set trap, in the one table
  // where empty is never a legitimate steady state.
  if (formRows.length === 0 || itemRows.length === 0) {
    console.warn('[warmInspections] form library came back empty — keeping the cached copy')
    return { formItems: 0, properties: 0 }
  }

  await db.transaction('rw',
    db.inspection_forms, db.inspection_form_sections, db.inspection_form_items, db.properties,
    async () => {
      // Replaced wholesale rather than reconciled by absence. These are small,
      // platform-owned, and fetched complete every time — so a clear-and-put is
      // both simpler and stricter than diffing, and a retired form stops being
      // offerable immediately.
      await db.inspection_forms.clear()
      await db.inspection_form_sections.clear()
      await db.inspection_form_items.clear()
      await db.inspection_forms.bulkPut(formRows)
      await db.inspection_form_sections.bulkPut(sectionRows)
      await db.inspection_form_items.bulkPut(itemRows)

      // Properties are org data and can legitimately be empty, so they are
      // reconciled rather than gated: a property removed from the org must stop
      // being offered as somewhere to inspect.
      const keep = new Set(propertyRows.map((p) => p.id))
      const stale = (await db.properties.toArray())
        .filter((p) => !keep.has(p.id))
        .map((p) => p.id)
      await db.properties.bulkDelete(stale)
      await db.properties.bulkPut(propertyRows)
    })

  return { formItems: itemRows.length, properties: propertyRows.length }
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

/**
 * Open work orders a failing item might be a repeat of (§6).
 *
 * WHY THIS IS WARMED AT ALL. The prompt has to fire where the inspector is
 * standing — in front of the appliance, at the property, with no signal. Asking
 * the server at fail time would mean the prompt works everywhere except the
 * place the whole feature exists for.
 *
 * THE CONCERN KEY IS RESOLVED LOCALLY, and that is the neat part: the device
 * already holds the entire form library (`cacheFormLibrary` above), so
 * `form_item_id -> concern_key` needs no second request. §5's point is that
 * several forms deliberately ask about one concern, so `handrail_secure` raised
 * from the safety form must surface when the seasonal form asks it.
 *
 * Never throws. A device that misses this shows no prompt and falls back to the
 * pre-§6 behaviour — a work order per failure, with the relationship noted —
 * which is a worse outcome than the prompt and a much better one than a failed
 * warm taking the walk with it.
 */
async function cacheOpenConcerns(
  db:          ReturnType<typeof getDashboardDb>,
  orgId:       string,
  propertyIds: string[],
): Promise<void> {
  if (propertyIds.length === 0) return

  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('work_orders')
      .select('id, wo_number, title, created_at, property_id, inspection_items!inner(form_item_id)')
      .eq('org_id', orgId)
      .in('property_id', propertyIds)
      .eq('source', 'inspection')
      .in('status', ['pending', 'quote_requested', 'assigned', 'in_progress'])
      // Oldest first: where two open work orders share a concern, the one worth
      // showing is the one that has been waiting longest.
      .order('created_at', { ascending: true })
      .limit(OPEN_CONCERN_LIMIT)

    if (error) {
      reportError(error, { site: 'dexie.dashboard.warmInspections.openConcerns' })
      // Left alone rather than cleared. A failed fetch is not evidence that
      // nothing is open, and wiping the cache here would silently disable the
      // prompt for a device that had a perfectly good copy.
      return
    }

    const concernByFormItem = new Map(
      (await db.inspection_form_items.toArray()).map((i) => [i.id, i.concern_key]),
    )

    const rows: OpenConcernRow[] = []
    const seen = new Set<string>()
    for (const wo of (data ?? []) as unknown as RawOpenWorkOrder[]) {
      const formItemId = embeddedFormItemId(wo)
      if (!formItemId) continue
      // Unresolved falls back to the form item id, which is exactly what the
      // fill screen computes for an item with no concern key — so a form
      // library that has not landed yet degrades to narrower matching rather
      // than to nothing.
      const concernKey = concernByFormItem.get(formItemId) ?? formItemId

      // One per (property, concern): the oldest, by the ORDER BY above.
      const dedupe = `${wo.property_id}|${concernKey}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)

      rows.push({
        id:         wo.id,
        propertyId: wo.property_id,
        concernKey,
        woNumber:   wo.wo_number,
        title:      wo.title,
        createdAt:  wo.created_at,
      })
    }

    await db.transaction('rw', db.open_wo_concerns, async () => {
      // Reconciled by absence, scoped to the properties this fetch covered — a
      // work order that has since been COMPLETED must stop being offered as a
      // predecessor, and a plain bulkPut would leave it there forever. The
      // scope is what stops this touching another property's cache, and the
      // fetch cannot be empty-by-error here because the error branch returned
      // above.
      const covered = new Set(propertyIds)
      const stale = await db.open_wo_concerns
        .filter((c) => covered.has(c.propertyId))
        .primaryKeys()
      const keep = new Set(rows.map((r) => r.id))
      await db.open_wo_concerns.bulkDelete(stale.filter((id) => !keep.has(id)))
      await db.open_wo_concerns.bulkPut(rows)
    })
  } catch (err) {
    console.warn('[warmInspections] open-concern warm failed (non-fatal):', err)
  }
}

/**
 * Ceiling on cached predecessors.
 *
 * One row per (property, concern) survives deduplication, and a property with
 * hundreds of simultaneously-open inspection-sourced work orders has a problem
 * this prompt is not going to solve. Explicit because `max_rows` would
 * otherwise truncate it silently at 1000.
 */
const OPEN_CONCERN_LIMIT = 500

interface RawOpenWorkOrder {
  id:          string
  wo_number:   string | null
  title:       string
  created_at:  string
  property_id: string
  inspection_items: unknown
}

/**
 * The embedded source item's `form_item_id`, whichever shape PostgREST returned.
 *
 * A to-one embed comes back as an object and a to-many as an array, and which
 * applies is decided by PostgREST's reading of the FK rather than by anything
 * here. Guessing wrong costs no error at all — every row is skipped and the
 * prompt simply never appears — so both shapes are accepted.
 */
function embeddedFormItemId(row: RawOpenWorkOrder): string | null {
  const raw = row.inspection_items
  const one = Array.isArray(raw) ? raw[0] : raw
  if (!one || typeof one !== 'object') return null
  const id = (one as { form_item_id?: unknown }).form_item_id
  return typeof id === 'string' ? id : null
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
