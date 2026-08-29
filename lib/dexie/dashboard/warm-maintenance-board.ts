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

import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/observability/report-error'
import type { Vendor, WorkOrder } from '@/types/database'

import { getDashboardDb } from './schema'

function canWarm(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  return true
}

export interface MaintenanceBoardWarmResult {
  workOrders: number
  vendors:    number
  skipped?:   'offline' | 'throttled'
}

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

/**
 * Pulls the open work-order board into the local cache.
 *
 * Never throws — a device that misses a warm is no worse off than before this
 * existed; it just falls back to whatever the server last rendered.
 */
export async function warmMaintenanceBoardForOffline(
  userId: string,
  orgId:  string,
  opts:   { force?: boolean } = {},
): Promise<MaintenanceBoardWarmResult> {
  if (!canWarm()) return { ...EMPTY, skipped: 'offline' }

  const db = getDashboardDb(userId, orgId)

  try {
    if (!opts.force && !(await isDue(db))) {
      return { ...EMPTY, skipped: 'throttled' }
    }

    const vendors = await cacheVendors(db, orgId)

    const supabase = createClient()
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

    // Stamped even on failure and even with nothing to warm — otherwise an org
    // with no open work orders (or a flaky query) re-runs this on every
    // dashboard mount, which is the case the throttle exists for.
    await db.sync_meta.put({ key: WARM_WATERMARK, value: new Date().toISOString() })

    if (error) {
      reportError(error, { site: 'dexie.dashboard.warmMaintenanceBoard.workOrders', orgId })
      // A failed fetch is not evidence the board is empty — leave the cache as
      // it was rather than wiping a device that had a perfectly good copy.
      return { ...EMPTY, vendors }
    }

    const rows = (data ?? []) as unknown as WorkOrder[]
    const pending = await pendingLocalCreateIds(db)

    await db.transaction('rw', db.work_orders, async () => {
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
    })

    return { workOrders: rows.length, vendors }
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

    if (error) {
      reportError(error, { site: 'dexie.dashboard.warmMaintenanceBoard.vendors', orgId })
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
