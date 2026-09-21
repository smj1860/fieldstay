'use client'

// lib/dexie/dashboard/warm-maintenance-board.ts
//
// Pre-caches the open work-order board while the tablet still has signal, so a
// PM who loses it can still see what they came to the property for.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GAP THIS CLOSES
//
// §8 shipped offline CREATE (createWorkOrderLocal / the Route Handler in
// app/api/work-orders/route.ts) but never the read half. The board
// (maintenance-board.tsx) is a Server Component reading Supabase directly, with
// no Dexie import at all — so two things were true at once:
//
//   A PM who raised a work order with no signal saw it vanish the moment the
//   create modal closed. It WAS written — to db.work_orders, by
//   createWorkOrderLocal — but nothing on the board read that table, so the
//   list stayed exactly as the last server render left it until a sync and a
//   refresh both landed.
//
//   A PM who lost signal ON the board saw whatever the SW's app-shell caching
//   happened to leave behind — nothing dashboard-specific, since sw.js
//   explicitly excludes `/maintenance` itself from its offline allowlist (the
//   two inspection sub-paths are the only ones in it).
//
// This warms `work_orders` (open statuses only, matching the page's own
// filter) and `vendors` — the two things maintenance-board.tsx's list actually
// renders per card besides the property name, which warmInspectionsForOffline
// already caches into `db.properties`. `crew_members` is deliberately NOT
// cached: grep confirms the board's WorkOrderRow carries no assigned-crew
// field at all — that assignment is a picker-only concept, not something a
// card displays — so caching a table nothing here reads would be scope
// nobody asked for.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PENDING LOCAL CREATE MUST SURVIVE THIS WARM'S RECONCILE PASS
//
// The reconcile-by-absence step below deletes any cached work order the
// server's response no longer lists — the same rule warmInspectionsForOffline
// applies to property_assets, for the same reason (a completed/closed work
// order must stop appearing). But a work order created OFFLINE, still queued
// in the outbox, is by definition absent from any server response: the server
// has never heard of it. A naive reconcile would delete it out from under the
// PM the moment this warm runs — turning "create work order offline" into
// "create it, then have it silently vanish 15 minutes later if you're still
// offline when the throttle next allows a warm." Every row with a pending
// `work_order.create` mutation is excluded from the stale-deletion set for
// exactly this reason; see the test that creates one and re-warms.
//
// THE PENDING SET IS READ BEFORE THE SELECT FIRES, and that ordering is not
// incidental. A work order can finish syncing — its outbox row deleted by the
// drain — WHILE the SELECT below is in flight. Read `pending` AFTER the
// SELECT and there is a real window where a just-synced work order is in
// neither set: its mutation is already gone (so it is not "pending"), and the
// SELECT's result was captured before the server had committed it (so it is
// not "covered" either) — reconcile-by-absence then deletes a work order that
// exists, correctly, on the server. Reading `pending` first closes the
// window: anything still queued at that instant stays protected no matter
// when it syncs afterward, and anything that had ALREADY synced by that
// instant was necessarily committed before the SELECT was even issued, so the
// SELECT is guaranteed to see it.

import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/observability/report-error'
import { DASHBOARD_WARM_TIMEOUT_MS, withTimeout } from '@/lib/http/timeout'
import type { Vendor, WorkOrder } from '@/types/database'

import { getDashboardDb } from './schema'
import { hasUsableSession } from './session-gate'

function canWarm(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  return true
}

export interface MaintenanceBoardWarmResult {
  workOrders: number
  vendors:    number
  /**
   * How many open work orders exist on the server past WORK_ORDER_LIMIT —
   * always present when known, 0 when nothing was truncated. Undefined only
   * when the count itself could not be determined.
   */
  omittedCount?: number
  skipped?:   'offline' | 'throttled' | 'unauthenticated' | 'timeout'
}

/**
 * sync_meta key holding how many open work orders exist on the server past
 * WORK_ORDER_LIMIT. Read by the dashboard's offline-cache-cap notice —
 * CLAUDE.md's "a cap that applies must SAY SO in the output", applied to the
 * one cache here that can silently truncate.
 */
export const WORK_ORDER_OMITTED_KEY = 'maintenance_board:work_orders_omitted_count'

/** sync_meta key holding the last known TRUE server-side open-work-order
 *  count — the cheap-invalidation watermark, distinct from the key above. */
const WORK_ORDER_COUNT_WATERMARK = 'maintenance_board:work_orders_count_watermark'

const EMPTY: MaintenanceBoardWarmResult = { workOrders: 0, vendors: 0 }

/** Matches the board's own open-status filter in app/(dashboard)/maintenance/page.tsx. */
const OPEN_STATUSES = ['pending', 'quote_requested', 'assigned', 'in_progress']

/**
 * Ceiling on cached work orders. The page's own query carries this exact
 * limit and the exact same reasoning: the `.in()` here is on STATUS, not a
 * short id list, so this is not bounded by anything but the org's actual open
 * count. A truncated cache would drop work orders off the offline board with
 * no sign they existed — worse than the online page's own truncation risk,
 * since there is no way to notice and retry with no signal.
 */
const WORK_ORDER_LIMIT = 2000

/** One row per vendor in the org — matches the page's own vendor query. */
const VENDOR_LIMIT = 1000

const WARM_WATERMARK = 'maintenance_board:last_warm_at'
const WARM_INTERVAL_MS = 15 * 60 * 1000

// One in-flight run per (userId, orgId) — see warm-inspections.ts's identical
// map for the full reasoning (React Strict Mode's double-invoke, a tablet
// reconnecting right as the layout mounts). Both calls would otherwise read
// isDue() as false before either had written the watermark.
const inFlight = new Map<string, Promise<MaintenanceBoardWarmResult>>()

/**
 * Outer safety net on top of every individual query's own AbortSignal — see
 * the identical constant in warm-inspections.ts for the full reasoning. This
 * pass is lighter (two sequential Supabase reads plus a count-only
 * aggregate, no route warms), so its budget is smaller.
 */
const WARM_PASS_TIMEOUT_MS = 60_000

/**
 * Pulls the open work-order board into the local cache.
 *
 * Never throws — a device that misses a warm is no worse off than before this
 * existed; it just falls back to whatever the server last rendered.
 */
export function warmMaintenanceBoardForOffline(
  userId: string,
  orgId:  string,
  opts:   { force?: boolean } = {},
): Promise<MaintenanceBoardWarmResult> {
  const key = `${userId}-${orgId}`
  const existing = inFlight.get(key)
  if (existing && !opts.force) return existing

  const run = withTimeout(() => runWarm(userId, orgId, opts), WARM_PASS_TIMEOUT_MS, 'warmMaintenanceBoardForOffline')
    .catch((err) => {
      // Only ever fires from the outer race's own timer — runWarm() never
      // throws on its own (see its top-level catch). See the identical
      // comment in warm-inspections.ts.
      console.warn('[warmMaintenanceBoard] warm pass abandoned by its outer timeout (non-fatal):', err)
      return { ...EMPTY, skipped: 'timeout' as const }
    })
    .finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key)
    })
  inFlight.set(key, run)
  return run
}

async function runWarm(
  userId: string,
  orgId:  string,
  opts:   { force?: boolean },
): Promise<MaintenanceBoardWarmResult> {
  if (!canWarm()) return { ...EMPTY, skipped: 'offline' }

  // Before the first query, not after it fails — see ./session-gate.ts. This
  // warmer's `vendors` read was one of the four that 42501'd on 2026-09-11, and
  // it is the one that carried an `org_id` tag (from a prop rendered while the
  // session was still good), which is what made a signed-out tab look like a
  // single org's RLS regression.
  if (!(await hasUsableSession())) return { ...EMPTY, skipped: 'unauthenticated' }

  const db = getDashboardDb(userId, orgId)

  try {
    if (!opts.force && !(await isDue(db))) {
      return { ...EMPTY, skipped: 'throttled' }
    }

    const vendors = await cacheVendors(db, orgId)

    // Re-checked, not just at the top: a token can expire between this call's
    // start and the work_orders query below on the flaky/high-latency
    // connection this feature is built around, and a later query going out
    // unauthenticated 42501s — exactly the incident ./session-gate.ts
    // documents (the vendors read was one of the four that day).
    if (!(await hasUsableSession())) return { ...EMPTY, vendors, skipped: 'unauthenticated' }

    // READ BEFORE THE SELECT FIRES, not after it resolves — the ordering is
    // load-bearing. A work order created offline can finish syncing (its
    // outbox row deleted by the drain) WHILE this SELECT is in flight. Reading
    // `pending` after the SELECT leaves a real window where a just-synced work
    // order is neither in `pending` (its mutation is already gone) nor in the
    // SELECT's result (the server had not committed it yet when the query
    // ran) — reconcile-by-absence then deletes it. Capturing `pending` first
    // closes the window: anything still queued at this instant is protected
    // regardless of when it syncs afterward, and anything that had ALREADY
    // synced by this instant was necessarily committed before the SELECT
    // below was even issued, so the SELECT is guaranteed to see it. See the
    // regression test that creates one and re-warms mid-fetch.
    const pending = await pendingLocalCreateIds(db)

    const supabase = createClient()

    // Cheap invalidation, not a real delta pull: a `count`-only aggregate is
    // far lighter than the bounded row fetch below. When it matches the last
    // count this warm saw AND nothing is queued locally waiting to change
    // that count (a local `work_order.create` would make the true server
    // count stale the moment it lands), the full fetch+reconcile below is
    // skipped — the cache cannot be wrong in the one way this warm corrects
    // (reconcile-by-absence) if the set's SIZE has not moved and nothing on
    // the device is about to change it.
    //
    // This is NOT a substitute for a real `updated_at`-watermark delta pull:
    // it cannot distinguish "nothing changed" from "one was added and a
    // different one was completed in the same window" — a same-size swap.
    // A full delta+periodic-reconciliation design (tracking a watermark,
    // fetching only rows past it, occasionally still doing a full pass to
    // catch deletes) is real behavioural surgery on the one table every
    // Maintenance page read also touches, and this fix scopes down to the
    // smaller, safe improvement instead: skip the expensive replace when a
    // cheap signal says nothing could have changed, accept the same-size-swap
    // gap as a known, bounded limitation (the 15-minute throttle already
    // means the board is never more than one interval stale regardless), and
    // do the real fetch on every count mismatch, same as before this fix.
    const { count: liveCount, error: countError } = await supabase
      .from('work_orders')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .in('status', OPEN_STATUSES)
      .abortSignal(AbortSignal.timeout(DASHBOARD_WARM_TIMEOUT_MS))

    if (!countError && typeof liveCount === 'number' && pending.length === 0) {
      const watermark = await db.sync_meta.get(WORK_ORDER_COUNT_WATERMARK)
      const lastCount = watermark ? Number(watermark.value) : null
      if (lastCount === liveCount) {
        const omittedCount = Math.max(0, liveCount - Math.min(liveCount, WORK_ORDER_LIMIT))
        await db.sync_meta.put({ key: WARM_WATERMARK, value: new Date().toISOString() })
        await db.sync_meta.put({ key: WORK_ORDER_OMITTED_KEY, value: String(omittedCount) })
        return { workOrders: await db.work_orders.count(), vendors, omittedCount }
      }
    }

    const { data, error } = await supabase
      .from('work_orders')
      .select(`
        id, property_id, vendor_id, wo_number, title, description, category,
        priority, status, source, scheduled_date, completed_date,
        estimated_cost, nte_amount, actual_cost, access_notes,
        completion_notes, completed_by_name, invoice_reference,
        portal_enabled, completion_token,
        vendor_acknowledged_at, vendor_acknowledged_by,
        completion_verified_at, completion_verified_by, vendor_dispatch_email,
        suggested_vendor_ids, suggested_crew_member_ids, suggestion_reasoning,
        suggestion_status, created_at, updated_at
      `)
      .eq('org_id', orgId)
      .in('status', OPEN_STATUSES)
      .order('created_at', { ascending: false })
      .limit(WORK_ORDER_LIMIT)
      .abortSignal(AbortSignal.timeout(DASHBOARD_WARM_TIMEOUT_MS))

    // Stamped even on failure and even with nothing to warm — otherwise an org
    // with no open work orders (or a flaky query) re-runs this on every
    // dashboard mount, which is the case the throttle exists for.
    await db.sync_meta.put({ key: WARM_WATERMARK, value: new Date().toISOString() })

    if (error) {
      reportError(error, { site: 'dexie.dashboard.warmMaintenanceBoard.workOrders', orgId, level: 'warning' })
      // A failed fetch is not evidence the board is empty — leave the cache as
      // it was rather than wiping a device that had a perfectly good copy.
      return { ...EMPTY, vendors }
    }

    const rows = (data ?? []) as unknown as WorkOrder[]
    // The count query's OWN error/shape does not gate this fetch — a count
    // that failed just means the omitted figure stays honestly unknown (0),
    // never that the work orders themselves are stale.
    const omittedCount = !countError && typeof liveCount === 'number'
      ? Math.max(0, liveCount - rows.length)
      : 0

    await db.transaction('rw', db.work_orders, db.sync_meta, async () => {
      const covered = rows.map((r) => r.id)
      const keep = new Set([...covered, ...pending])
      // Reconciled by absence, but never against a row this device is still
      // trying to send — see the header comment. Empty IS a legitimate steady
      // state here (an org can genuinely have zero open work orders), and this
      // fetch cannot be empty-BY-ERROR, because the error branch returned above.
      const allIds = await db.work_orders.toCollection().primaryKeys()
      const stale = allIds.filter((id) => !keep.has(id))
      await db.work_orders.bulkDelete(stale)
      await db.work_orders.bulkPut(rows)
      await db.sync_meta.put({
        key:   WORK_ORDER_COUNT_WATERMARK,
        value: String(!countError && typeof liveCount === 'number' ? liveCount : rows.length),
      })
      await db.sync_meta.put({ key: WORK_ORDER_OMITTED_KEY, value: String(omittedCount) })
    })

    return { workOrders: rows.length, vendors, omittedCount }
  } catch (err) {
    console.warn('[warmMaintenanceBoard] warm failed (non-fatal):', err)
    return EMPTY
  }
}

/**
 * The org's active vendors. Reconciled by absence like `properties` in
 * warmInspectionsForOffline: a deactivated vendor must stop being offered
 * (and stop being the name shown on a cached card), and the query already
 * filters `is_active`, so absence from the fetch always means exactly that.
 */
async function cacheVendors(
  db:    ReturnType<typeof getDashboardDb>,
  orgId: string,
): Promise<number> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('vendors')
      .select('id, org_id, name, specialty, phone, email, lat, lng')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('name')
      .limit(VENDOR_LIMIT)
      .abortSignal(AbortSignal.timeout(DASHBOARD_WARM_TIMEOUT_MS))

    if (error) {
      reportError(error, { site: 'dexie.dashboard.warmMaintenanceBoard.vendors', orgId, level: 'warning' })
      return 0
    }

    const rows = (data ?? []) as unknown as Vendor[]

    await db.transaction('rw', db.vendors, async () => {
      await db.vendors.clear()
      await db.vendors.bulkPut(rows)
    })

    return rows.length
  } catch (err) {
    console.warn('[warmMaintenanceBoard] vendor warm failed (non-fatal):', err)
    return 0
  }
}

/** targetIds of every `work_order.create` mutation still sitting in the outbox. */
async function pendingLocalCreateIds(db: ReturnType<typeof getDashboardDb>): Promise<string[]> {
  const rows = await db.mutations.where('kind').equals('work_order.create').toArray()
  return rows.map((r) => r.targetId)
}

async function isDue(db: ReturnType<typeof getDashboardDb>): Promise<boolean> {
  const row = await db.sync_meta.get(WARM_WATERMARK)
  if (!row?.value) return true
  const last = Date.parse(row.value)
  // An unparseable watermark reads as "never warmed", not as a comparison
  // against NaN — every such comparison is false, which would disable
  // warming permanently and silently.
  return Number.isNaN(last) || Date.now() - last >= WARM_INTERVAL_MS
}
