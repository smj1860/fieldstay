import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDashboardDb, getDashboardDb } from '@/lib/dexie/dashboard/schema'
import type { WorkOrder } from '@/types/database'

// ============================================================================
// THE BOARD WAS WRITE-ONLY OFFLINE.
//
// createWorkOrderLocal has always written a full optimistic row into
// db.work_orders — but nothing read that table, so a work order raised with no
// signal vanished from the list the moment the create modal closed. It WAS
// there; nothing was looking.
//
// These tests cover the warm pass that makes the rest of the board visible
// too, and — the one property that actually matters — that this warm's own
// reconcile-by-absence step can never delete the very row a PM is still
// trying to send.
// ============================================================================

const USER = '11111111-2222-3333-4444-555555555555'
const ORG  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const workOrder = (id: string, over: Partial<WorkOrder> = {}): WorkOrder => ({
  id, org_id: ORG, property_id: 'prop-1', vendor_id: null,
  wo_number: 'WO-1', title: 'Fix handrail', description: null,
  category: 'general', priority: 'medium', status: 'pending', source: 'manual',
  scheduled_date: null, completed_date: null,
  estimated_cost: null, nte_amount: null, actual_cost: null,
  access_notes: null, portal_enabled: false, completion_token: null,
  completion_notes: null, completed_by_name: null, invoice_reference: null,
  vendor_acknowledged_at: null, vendor_acknowledged_by: null,
  completion_verified_at: null, completion_verified_by: null,
  vendor_dispatch_email: null,
  suggested_vendor_ids: null, suggested_crew_member_ids: null,
  suggestion_reasoning: null, suggestion_status: null,
  created_at: '2026-08-28T10:00:00Z', updated_at: '2026-08-28T10:00:00Z',
  ...over,
} as WorkOrder)

let workOrderRows: { data: unknown; error: unknown } = { data: [], error: null }
let vendorRows:    { data: unknown; error: unknown } = { data: [], error: null }

// Fires exactly when the work_orders SELECT's response is being read — lets a
// test model something completing concurrently with that request, the same
// way the outbox drain can finish syncing a work order while this warm's own
// SELECT is still in flight.
let onWorkOrdersRead: (() => Promise<void>) | null = null

// Same idea, for the vendors query — which runs BEFORE the mid-pass session
// re-check, so a test can use it to simulate the session lapsing between the
// vendors fetch and the work_orders fetch.
let onVendorsRead: (() => Promise<void>) | null = null

// getSession() is what the warm's session gate asks, and it is not a storage
// peek: supabase-js refreshes an expired token inside it and returns null when
// that refresh fails. `null` here therefore models the real production case —
// a tab whose session has lapsed and cannot be renewed.
let session: unknown = { access_token: 'jwt' }
let sessionCalls = 0

function fakeSupabase() {
  return {
    auth: {
      getSession: async () => {
        sessionCalls++
        return { data: { session }, error: null }
      },
    },
    from(table: string) {
      const byTable: Record<string, () => { data: unknown; error: unknown }> = {
        work_orders: () => workOrderRows,
        vendors:     () => vendorRows,
      }
      const result = byTable[table] ?? (() => ({ data: [], error: null }))
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) builder[m] = () => builder
      builder.then = (resolve: (v: unknown) => unknown) => {
        const hook = table === 'work_orders' ? onWorkOrdersRead
          : table === 'vendors' ? onVendorsRead
          : null
        return (hook ? hook() : Promise.resolve()).then(() => resolve(result()))
      }
      return builder
    },
  }
}

vi.mock('@/lib/supabase/client', () => ({ createClient: () => fakeSupabase() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const { warmMaintenanceBoardForOffline } = await import('@/lib/dexie/dashboard/warm-maintenance-board')

beforeEach(async () => {
  workOrderRows    = { data: [], error: null }
  vendorRows       = { data: [], error: null }
  onWorkOrdersRead = null
  onVendorsRead    = null
  session          = { access_token: 'jwt' }
  sessionCalls     = 0
  vi.stubGlobal('navigator', { onLine: true })

  closeDashboardDb()
  const db = getDashboardDb(USER, ORG)
  await db.open()
  await Promise.all([db.work_orders.clear(), db.vendors.clear(), db.sync_meta.clear(), db.mutations.clear()])
})

afterEach(() => { vi.unstubAllGlobals() })

describe('warmMaintenanceBoardForOffline', () => {
  it('caches open work orders and vendors', async () => {
    workOrderRows = { data: [workOrder('wo-1')], error: null }
    vendorRows    = { data: [{ id: 'v-1', org_id: ORG, name: 'Ace Plumbing', specialty: 'plumbing' }], error: null }

    const result = await warmMaintenanceBoardForOffline(USER, ORG)

    expect(result).toMatchObject({ workOrders: 1, vendors: 1 })
    expect(await getDashboardDb(USER, ORG).work_orders.get('wo-1')).toBeTruthy()
    expect(await getDashboardDb(USER, ORG).vendors.get('v-1')).toBeTruthy()
  })

  // ── The property that actually matters ─────────────────────────────────
  it('a work order still queued in the outbox SURVIVES the reconcile pass', async () => {
    const db = getDashboardDb(USER, ORG)
    // Simulates createWorkOrderLocal: the optimistic row plus its outbox entry,
    // written together. The server has never heard of this id — it is by
    // definition absent from workOrderRows.
    await db.work_orders.put(workOrder('local-1', { wo_number: null }))
    await db.mutations.add({
      kind: 'work_order.create', targetId: 'local-1', orgId: ORG,
      payload: {}, createdAt: new Date().toISOString(), retryCount: 0,
    })
    workOrderRows = { data: [workOrder('server-1')], error: null }

    await warmMaintenanceBoardForOffline(USER, ORG)

    expect(await db.work_orders.get('local-1')).toBeTruthy()
    expect(await db.work_orders.get('server-1')).toBeTruthy()
  })

  it('a work order that finishes syncing WHILE the SELECT is in flight survives', async () => {
    // The race this warm's ordering exists to close. `workOrderRows` is EMPTY
    // — the server had not committed the create yet when this SELECT actually
    // ran — but by the time the outbox drain finishes elsewhere and deletes
    // the mutation, the SELECT response has still not been read. If `pending`
    // were captured AFTER the SELECT (the pre-fix ordering) this sequence
    // deletes a work order that, on the server, already exists: the mutation
    // is gone (not "pending") and the stale response never saw it either (not
    // "covered"). Reading `pending` before the SELECT fires closes the
    // window — see the header comment in warm-maintenance-board.ts.
    const db = getDashboardDb(USER, ORG)
    await db.work_orders.put(workOrder('local-1', { wo_number: null }))
    await db.mutations.add({
      kind: 'work_order.create', targetId: 'local-1', orgId: ORG,
      payload: {}, createdAt: new Date().toISOString(), retryCount: 0,
    })
    workOrderRows = { data: [], error: null }
    onWorkOrdersRead = async () => {
      await db.mutations.where('targetId').equals('local-1').delete()
    }

    await warmMaintenanceBoardForOffline(USER, ORG)

    expect(await db.work_orders.get('local-1')).toBeTruthy()
  })

  it('a work order that finished sending is no longer exempt, and is reconciled normally', async () => {
    // The outbox row is gone (the create succeeded and was drained) but the
    // warm hasn't yet re-fetched to pick up its new, non-open status —
    // reconcile-by-absence must still be able to remove it, or a work order
    // that was completed elsewhere stays on the board forever.
    const db = getDashboardDb(USER, ORG)
    await db.work_orders.put(workOrder('now-completed'))
    workOrderRows = { data: [], error: null }

    await warmMaintenanceBoardForOffline(USER, ORG)

    expect(await db.work_orders.get('now-completed')).toBeUndefined()
  })

  it('a FAILED work-order query keeps the cached copy', async () => {
    const db = getDashboardDb(USER, ORG)
    await db.work_orders.put(workOrder('already-cached'))
    workOrderRows = { data: null, error: { message: 'boom' } }

    await warmMaintenanceBoardForOffline(USER, ORG)

    expect(await db.work_orders.get('already-cached')).toBeTruthy()
  })

  it('a deactivated vendor is removed, not left to be offered', async () => {
    const db = getDashboardDb(USER, ORG)
    await db.vendors.put({ id: 'gone', org_id: ORG, name: 'Old Vendor' } as never)
    vendorRows = { data: [{ id: 'still-here', org_id: ORG, name: 'Ace' }], error: null }

    await warmMaintenanceBoardForOffline(USER, ORG)

    expect(await db.vendors.get('gone')).toBeUndefined()
    expect(await db.vendors.get('still-here')).toBeTruthy()
  })

  it('does nothing offline, and says so', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(await warmMaintenanceBoardForOffline(USER, ORG)).toMatchObject({ skipped: 'offline' })
  })

  // ── The 2026-09-11 false alarm ────────────────────────────────────────────
  // An expired session sends every read out as `anon`, which holds no table
  // grants, so the whole pass returns 42501 — reported as an RLS regression
  // rather than as the signed-out tab it is. The gate runs BEFORE the first
  // query, so the count that matters is zero queries, not zero rows.
  it('makes no query at all when the session has lapsed', async () => {
    session = null
    vendorRows = { data: [{ id: 'v-1', org_id: ORG, name: 'Ace' }], error: null }

    const result = await warmMaintenanceBoardForOffline(USER, ORG)

    expect(result).toMatchObject({ skipped: 'unauthenticated', workOrders: 0, vendors: 0 })
    expect(await getDashboardDb(USER, ORG).vendors.get('v-1')).toBeUndefined()
  })

  it('does not let a lapsed session wipe a cache it cannot refresh', async () => {
    const db = getDashboardDb(USER, ORG)
    await db.vendors.put({ id: 'kept', org_id: ORG, name: 'Ace' } as never)

    session = null
    await warmMaintenanceBoardForOffline(USER, ORG, { force: true })

    // Reconcile-by-absence never runs, so the device keeps the copy it had.
    expect(await db.vendors.get('kept')).toBeTruthy()
  })

  it('throttles repeat warms', async () => {
    await warmMaintenanceBoardForOffline(USER, ORG)
    expect(await warmMaintenanceBoardForOffline(USER, ORG)).toMatchObject({ skipped: 'throttled' })
  })

  it('force bypasses the throttle', async () => {
    await warmMaintenanceBoardForOffline(USER, ORG)
    workOrderRows = { data: [workOrder('wo-2')], error: null }
    expect((await warmMaintenanceBoardForOffline(USER, ORG, { force: true })).workOrders).toBe(1)
  })

  // A session that is fine when the pass starts but lapses between the
  // vendors query and the work_orders query is a different failure than "no
  // session at all" — the flaky-connection case the mid-pass re-check exists
  // for. Without it, the work_orders query would go out anyway and 'wo-1'
  // would land in the cache despite the lapsed session.
  it('bails mid-pass when the session lapses AFTER vendors warm but before work orders fetch', async () => {
    vendorRows    = { data: [{ id: 'v-1', org_id: ORG, name: 'Ace' }], error: null }
    workOrderRows = { data: [workOrder('wo-1')], error: null }
    onVendorsRead = async () => { session = null }

    const result = await warmMaintenanceBoardForOffline(USER, ORG)

    expect(result).toMatchObject({ skipped: 'unauthenticated', workOrders: 0 })
    // Vendors warmed before the lapse and are kept.
    expect(result.vendors).toBe(1)
    expect(await getDashboardDb(USER, ORG).work_orders.get('wo-1')).toBeUndefined()
    expect(sessionCalls).toBeGreaterThanOrEqual(2)
  })

  // React Strict Mode's mount/cleanup/remount double-invoke, and a tablet
  // reconnecting right as the layout mounts, both call this before either call
  // has written the watermark. Without the in-flight map, both would read
  // isDue() as false and run a full pass each.
  it('two un-forced calls started back to back share ONE pass', async () => {
    workOrderRows = { data: [workOrder('wo-1')], error: null }

    const first  = warmMaintenanceBoardForOffline(USER, ORG)
    const second = warmMaintenanceBoardForOffline(USER, ORG)

    expect(second).toBe(first)

    const before = sessionCalls
    await Promise.all([first, second])
    // One pass makes two session checks (top + mid-pass) — a second
    // concurrent pass would double this.
    expect(sessionCalls - before).toBeLessThanOrEqual(2)
  })

  it('a FORCED call does not join an un-forced pass already in flight, and each forced call gets its own run', async () => {
    workOrderRows = { data: [workOrder('wo-1')], error: null }

    const background = warmMaintenanceBoardForOffline(USER, ORG)
    const forcedA     = warmMaintenanceBoardForOffline(USER, ORG, { force: true })
    const forcedB     = warmMaintenanceBoardForOffline(USER, ORG, { force: true })

    // force always starts a new run rather than joining ANY existing one —
    // the in-flight map exists to dedupe accidental double-mounts, not to
    // throttle a deliberate re-warm.
    expect(forcedA).not.toBe(background)
    expect(forcedB).not.toBe(forcedA)

    await Promise.all([background, forcedA, forcedB])
  })

  // The `.finally()` cleanup only deletes the map entry when it still points
  // at ITS OWN run: `if (inFlight.get(key) === run)`. This is what stops an
  // OLDER call's cleanup from evicting a NEWER call's still-running entry.
  // Exercised by making the first forced call finish before the second one
  // does, then confirming a third (un-forced) call still JOINS the second
  // rather than starting a redundant fourth pass because the map entry was
  // wiped out from under it.
  it("an older forced call's cleanup does not evict a newer forced call's still-running entry", async () => {
    workOrderRows = { data: [workOrder('wo-1')], error: null }

    // A queue rather than two nullable variables — avoids TS narrowing a
    // closure-mutated `let` back to `never` across the `await` below, and
    // reads just as clearly: releases[0] is the first read to arrive, [1]
    // the second.
    const releases: Array<() => void> = []
    onWorkOrdersRead = () => new Promise<void>((resolve) => { releases.push(resolve) })

    const forcedA = warmMaintenanceBoardForOffline(USER, ORG, { force: true })
    const forcedB = warmMaintenanceBoardForOffline(USER, ORG, { force: true })

    // Both calls have several real (non-microtask) awaits ahead of the
    // work_orders read — the session check and the Dexie/IndexedDB queries —
    // so the gate isn't installed synchronously. Poll with a macrotask tick
    // rather than assuming a fixed number of microtask flushes gets there.
    while (releases.length < 1) await new Promise((r) => setTimeout(r, 0))
    releases[0]!()
    await forcedA

    // forcedB is still pending (its release not yet called). A plain call
    // now must JOIN it, not start a third pass.
    const third = warmMaintenanceBoardForOffline(USER, ORG)
    expect(third).toBe(forcedB)

    while (releases.length < 2) await new Promise((r) => setTimeout(r, 0))
    releases[1]!()
    await Promise.all([forcedB, third])
  })
})
