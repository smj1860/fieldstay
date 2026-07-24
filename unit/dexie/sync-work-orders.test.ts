import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
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

  it('delta sync: uses the id snapshot to remove WOs that completed or were reassigned away', async () => {
    await db().crew_work_orders.bulkPut([
      { id: 'wo1', property_id: 'p1', status: 'assigned' },
      { id: 'wo-done', property_id: 'p1', status: 'in_progress' },
    ])
    await db().properties.bulkPut([{ id: 'p1' }])
    const cursorValue = '2026-07-24T09:00:00.000Z'
    await db().sync_meta.put({ key: 'cursor:work_orders', value: cursorValue })

    const supabase = makeFakeSupabase({
      // 1st work_orders query = id snapshot (wo-done is completed → absent);
      // 2nd = delta rows (nothing changed within the crew's open set)
      work_orders: [{ data: [{ id: 'wo1' }] }, { data: [] }],
    })

    await syncWorkOrders(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    expect(await db().crew_work_orders.get('wo-done')).toBeUndefined()
    expect(await db().crew_work_orders.get('wo1')).toBeDefined()

    const gtCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'gt')
    expect(gtCall?.args).toEqual(['updated_at', cursorValue])
    // Empty delta → cursor unchanged
    expect((await db().sync_meta.get('cursor:work_orders'))?.value).toBe(cursorValue)
  })

  it('delta sync: changed rows land in Dexie and only missing properties are fetched', async () => {
    await db().crew_work_orders.bulkPut([{ id: 'wo1', property_id: 'p1', status: 'assigned' }])
    await db().properties.bulkPut([{ id: 'p1' }])
    await db().sync_meta.put({ key: 'cursor:work_orders', value: '2026-07-24T09:00:00.000Z' })

    const wo2 = { ...WO1, id: 'wo2', property_id: 'p2', updated_at: '2026-07-24T11:00:00.000Z' }
    const supabase = makeFakeSupabase({
      work_orders: [{ data: [{ id: 'wo1' }, { id: 'wo2' }] }, { data: [wo2] }],
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
