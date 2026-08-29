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

function fakeSupabase() {
  return {
    from(table: string) {
      const byTable: Record<string, () => { data: unknown; error: unknown }> = {
        work_orders: () => workOrderRows,
        vendors:     () => vendorRows,
      }
      const result = byTable[table] ?? (() => ({ data: [], error: null }))
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) builder[m] = () => builder
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve)
      return builder
    },
  }
}

vi.mock('@/lib/supabase/client', () => ({ createClient: () => fakeSupabase() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const { warmMaintenanceBoardForOffline } = await import('@/lib/dexie/dashboard/warm-maintenance-board')

beforeEach(async () => {
  workOrderRows = { data: [], error: null }
  vendorRows    = { data: [], error: null }
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

  it('throttles repeat warms', async () => {
    await warmMaintenanceBoardForOffline(USER, ORG)
    expect(await warmMaintenanceBoardForOffline(USER, ORG)).toMatchObject({ skipped: 'throttled' })
  })

  it('force bypasses the throttle', async () => {
    await warmMaintenanceBoardForOffline(USER, ORG)
    workOrderRows = { data: [workOrder('wo-2')], error: null }
    expect((await warmMaintenanceBoardForOffline(USER, ORG, { force: true })).workOrders).toBe(1)
  })
})
