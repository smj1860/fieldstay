import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { recordInventoryConsumption } from '@/lib/inngest/functions/inventory-consumption-recorded'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// Queue-based mock, same shape as inventory-events.test.ts.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

const baseEvent = {
  org_id:      'org_1',
  property_id: 'prop_1',
  source_type: 'count' as const,
  source_id:   'count_1',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('recordInventoryConsumption', () => {
  it('drops samples for item ids outside the org/property, keeping only verified ones', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { id: 'prop_1', max_guests: 6, avg_stay_length: 3 }, error: null }],
      // Only item_1 comes back verified — item_bad is dropped.
      inventory_items: [{ data: [{ id: 'item_1' }], error: null }],
      inventory_consumption_samples: [
        { data: null, error: null }, // insert
        { data: [{ rate_per_guest_night: 0.2, recorded_at: '2026-07-01T00:00:00Z' }], error: null }, // recompute-stats select
      ],
      inventory_consumption_stats: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(recordInventoryConsumption, {
      event: {
        data: {
          ...baseEvent,
          samples: [
            { inventory_item_id: 'item_1', consumed_qty: 4 },
            { inventory_item_id: 'item_bad', consumed_qty: 2 },
          ],
        },
      },
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const insertCall = supabase.calls.find((c) => c.table === 'inventory_consumption_samples' && c.method === 'upsert')
    const rows = insertCall?.args[0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inventory_item_id: 'item_1' })

    expect(result).toMatchObject({ inserted: 1 })
  })

  it('inserts samples idempotently via onConflict + ignoreDuplicates on the composite key', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { id: 'prop_1', max_guests: 6, avg_stay_length: 3 }, error: null }],
      inventory_items: [{ data: [{ id: 'item_1' }], error: null }],
      inventory_consumption_samples: [
        { data: null, error: null },
        { data: [{ rate_per_guest_night: 0.2, recorded_at: '2026-07-01T00:00:00Z' }], error: null },
      ],
      inventory_consumption_stats: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(recordInventoryConsumption, {
      event: { data: { ...baseEvent, samples: [{ inventory_item_id: 'item_1', consumed_qty: 4 }] } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const insertCall = supabase.calls.find((c) => c.table === 'inventory_consumption_samples' && c.method === 'upsert')
    expect(insertCall?.args[1]).toEqual({ onConflict: 'source_type,source_id,inventory_item_id', ignoreDuplicates: true })
  })

  it('averages the most recent sample window into inventory_consumption_stats', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { id: 'prop_1', max_guests: 6, avg_stay_length: 3 }, error: null }],
      inventory_items: [{ data: [{ id: 'item_1' }], error: null }],
      inventory_consumption_samples: [
        { data: null, error: null }, // insert
        {
          data: [
            { rate_per_guest_night: 0.2, recorded_at: '2026-07-03T00:00:00Z' },
            { rate_per_guest_night: 0.4, recorded_at: '2026-07-01T00:00:00Z' },
          ],
          error: null,
        },
      ],
      inventory_consumption_stats: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(recordInventoryConsumption, {
      event: { data: { ...baseEvent, samples: [{ inventory_item_id: 'item_1', consumed_qty: 4 }] } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const statsUpsert = supabase.calls.find((c) => c.table === 'inventory_consumption_stats' && c.method === 'upsert')
    const row = statsUpsert?.args[0] as Record<string, unknown>
    expect(row).toMatchObject({
      property_id:       'prop_1',
      inventory_item_id: 'item_1',
      org_id:            'org_1',
      sample_count:      2,
      last_sample_at:    '2026-07-03T00:00:00Z',
    })
    expect(row.avg_rate_per_guest_night as number).toBeCloseTo(0.3)
  })

  it('fires the recompute event only when at least one sample was inserted', async () => {
    const step = runAllStep()
    const supabase = makeSupabase({
      properties: [{ data: { id: 'prop_1', max_guests: 6, avg_stay_length: 3 }, error: null }],
      // No verified items at all -> everything gets dropped.
      inventory_items: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(recordInventoryConsumption, {
      event: { data: { ...baseEvent, samples: [{ inventory_item_id: 'item_1', consumed_qty: 4 }] } },
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ inserted: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('sends inventory/par-recompute-requested with the touched item ids after a successful insert', async () => {
    const step = runAllStep()
    const supabase = makeSupabase({
      properties: [{ data: { id: 'prop_1', max_guests: 6, avg_stay_length: 3 }, error: null }],
      inventory_items: [{ data: [{ id: 'item_1' }], error: null }],
      inventory_consumption_samples: [
        { data: null, error: null },
        { data: [{ rate_per_guest_night: 0.2, recorded_at: '2026-07-01T00:00:00Z' }], error: null },
      ],
      inventory_consumption_stats: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(recordInventoryConsumption, {
      event: { data: { ...baseEvent, samples: [{ inventory_item_id: 'item_1', consumed_qty: 4 }] } },
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(step.sendEvent).toHaveBeenCalledWith('send-par-recompute', {
      name: 'inventory/par-recompute-requested',
      data: { org_id: 'org_1', property_id: 'prop_1', inventory_item_ids: ['item_1'] },
    })
  })
})
