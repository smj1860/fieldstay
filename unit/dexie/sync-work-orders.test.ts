import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  // Logout shutdown latch (lib/dexie/schema.ts) — never latched in these tests.
  isDexieShutdown: () => false,
}))

import { syncWorkOrders } from '@/lib/dexie/sync/work-orders'
import type { DexieSupabaseClient } from '@/lib/dexie/sync/types'

const WO1 = {
  id: 'wo1', org_id: 'org1', property_id: 'p1', assigned_crew_member_id: 'crew1',
  title: 'Fix faucet', description: null, status: 'assigned', priority: 'medium',
  scheduled_date: null, wo_number: 'WO-001', created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-24T10:00:00.000Z',
}

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

describe('syncWorkOrders', () => {
  beforeEach(() => {
    holder.db = makeFakeDexieDb()
    vi.clearAllMocks()
  })

  it('first sync (no cursor): full pull, caches rows without updated_at, seeds the cursor', async () => {
    const supabase = makeFakeSupabase({
      work_orders: [{ data: [WO1] }],
      properties:  [{ data: [{ id: 'p1', org_id: 'org1', name: 'Lake House' }] }],
    })

    await syncWorkOrders(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    const stored = await db().crew_work_orders.get('wo1')
    expect(stored).toBeDefined()
    expect(stored).not.toHaveProperty('updated_at')
    expect(await db().properties.get('p1')).toBeDefined()
    expect(await db().sync_meta.get('cursor:work_orders')).toBeDefined()
    // Full pull — no delta filter
    expect(supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'gt')).toHaveLength(0)
  })

  it('delta sync: a closed WO arrives as a tombstone — no membership snapshot needed', async () => {
    // Completion and cancellation used to be invisible to the delta (it
    // filtered them out), so an id snapshot had to run on EVERY tick just to
    // notice them. Dropping the status filter turns them into tombstones and
    // makes the routine pass a single query.
    await db().crew_work_orders.bulkPut([
      { id: 'wo1', property_id: 'p1', status: 'assigned' },
      { id: 'wo-done', property_id: 'p1', status: 'in_progress' },
    ])
    await db().properties.bulkPut([{ id: 'p1' }])
    const cursorValue = '2026-07-24T09:00:00.000Z'
    await db().sync_meta.put({ key: 'cursor:work_orders', value: cursorValue })

    const supabase = makeFakeSupabase({
      work_orders: [{ data: [
        { ...WO1, id: 'wo-done', status: 'completed', updated_at: '2026-07-24T11:00:00.000Z' },
      ] }],
    })

    await syncWorkOrders(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    expect(await db().crew_work_orders.get('wo-done')).toBeUndefined()
    expect(await db().crew_work_orders.get('wo1')).toBeDefined()

    // ONE work_orders query, not two.
    const selects = supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'select')
    expect(selects).toHaveLength(1)

    const gtCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'gt')
    expect(gtCall?.args).toEqual(['updated_at', cursorValue])

    // The cursor advances past the tombstone too — otherwise the closed WO
    // stays newer than the cursor and is re-returned on every pull forever.
    expect(String((await db().sync_meta.get('cursor:work_orders'))?.value) > cursorValue).toBe(true)
  })

  it('delta sync: reassignment away is removed only on a reconcile pass', async () => {
    // The one departure a delta genuinely cannot see: the row stops matching
    // assigned_crew_member_id, so it is not returned at all.
    await db().crew_work_orders.bulkPut([
      { id: 'wo1', property_id: 'p1', status: 'assigned' },
      { id: 'wo-moved', property_id: 'p1', status: 'assigned' },
    ])
    await db().sync_meta.put({ key: 'cursor:work_orders', value: '2026-07-24T09:00:00.000Z' })

    // Routine pass: delta only, nothing changed → the reassigned WO lingers.
    const routine = makeFakeSupabase({ work_orders: [{ data: [] }] })
    await syncWorkOrders(routine as unknown as DexieSupabaseClient, 'u1', 'crew1')
    expect(await db().crew_work_orders.get('wo-moved')).toBeDefined()
    expect(routine.calls.filter((c) => c.table === 'work_orders' && c.method === 'select')).toHaveLength(1)

    // Reconcile pass: delta + membership snapshot → it goes.
    const reconciling = makeFakeSupabase({
      work_orders: [{ data: [] }, { data: [{ id: 'wo1' }] }],
    })
    await syncWorkOrders(reconciling as unknown as DexieSupabaseClient, 'u1', 'crew1', false, true)

    expect(await db().crew_work_orders.get('wo-moved')).toBeUndefined()
    expect(await db().crew_work_orders.get('wo1')).toBeDefined()
    expect(reconciling.calls.filter((c) => c.table === 'work_orders' && c.method === 'select')).toHaveLength(2)
  })

  it('full pull drains every page — a full first page is not the whole membership', async () => {
    // The full pull doubles as the membership snapshot: anything cached but
    // absent from it is deleted off the device. Reading one unbounded page and
    // treating it as complete meant PostgREST's silent max_rows cutoff would
    // present rows past the cap as "no longer assigned" and wipe them locally,
    // with a 200 and nothing logged. Draining removes the ceiling.
    const PAGE = 200
    const page1 = Array.from({ length: PAGE }, (_, i) => ({ ...WO1, id: `wo${i}` }))
    const page2 = [{ ...WO1, id: 'wo-past-the-cap' }]
    await db().crew_work_orders.bulkPut([{ id: 'wo-past-the-cap', property_id: 'p1', status: 'assigned' }])
    await db().properties.bulkPut([{ id: 'p1' }])

    const supabase = makeFakeSupabase({
      work_orders: [{ data: page1 }, { data: page2 }],
    })

    await syncWorkOrders(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    expect(
      await db().crew_work_orders.get('wo-past-the-cap'),
      'a row on the second page must not be read as a departure and deleted',
    ).toBeDefined()

    const ranges = supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'range')
    expect(ranges.map((c) => c.args)).toEqual([[0, PAGE - 1], [PAGE, 2 * PAGE - 1]])
  })

  it('delta sync: changed rows land in Dexie and only missing properties are fetched', async () => {
    await db().crew_work_orders.bulkPut([{ id: 'wo1', property_id: 'p1', status: 'assigned' }])
    await db().properties.bulkPut([{ id: 'p1' }])
    await db().sync_meta.put({ key: 'cursor:work_orders', value: '2026-07-24T09:00:00.000Z' })

    const wo2 = { ...WO1, id: 'wo2', property_id: 'p2', updated_at: '2026-07-24T11:00:00.000Z' }
    const supabase = makeFakeSupabase({
      work_orders: [{ data: [wo2] }],
      properties:  [{ data: [{ id: 'p2', org_id: 'org1', name: 'Cabin' }] }],
    })

    await syncWorkOrders(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    expect(await db().crew_work_orders.get('wo2')).toBeDefined()
    // p1 already cached — only p2 requested
    const propIn = supabase.calls.find((c) => c.table === 'properties' && c.method === 'in')
    expect(propIn?.args).toEqual(['id', ['p2']])
    // Cursor advanced past the old value
    expect(String((await db().sync_meta.get('cursor:work_orders'))?.value) > '2026-07-24T09:00:00.000Z').toBe(true)
  })
})
