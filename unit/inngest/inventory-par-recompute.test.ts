import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { recomputeInventoryParLevels } from '@/lib/inngest/functions/inventory-par-recompute'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Queue-based mock, same shape as inventory-events.test.ts / platform-inventory-template-broadcast.test.ts.
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

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const property = { id: 'prop_1', bathrooms: 2, bedrooms: 3, max_guests: 6, avg_stay_length: 3 }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('recomputeInventoryParLevels', () => {
  it('filters on par_mode = smart, writes only changed rows with id/par_level/par_resolved_at, and logs audit', async () => {
    const supabase = makeSupabase({
      properties: [{ data: [property], error: null }],
      inventory_items: [
        { data: [{ id: 'item_1', par_level: 1, par_mode: 'smart', smart_group: 'bathroom_essential', base_qty: 2, auto_adjust: true }], error: null },
        { data: null, error: null }, // upsert
      ],
      inventory_consumption_stats: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(recomputeInventoryParLevels, {
      event: { data: { org_id: 'org_1' } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    // (a) static-item guarantee: the item fetch filters on par_mode = 'smart'.
    expect(supabase.calls.some((c) => c.table === 'inventory_items' && c.method === 'eq' && c.args[0] === 'par_mode' && c.args[1] === 'smart')).toBe(true)

    // ceil(base_qty 2 * bathrooms 2 * 1.15) = 5, differs from stored par_level 1 -> a write.
    const upsertCall = supabase.calls.find((c) => c.table === 'inventory_items' && c.method === 'upsert')
    const rows = upsertCall?.args[0] as Array<Record<string, unknown>>
    expect(rows).toEqual([{ id: 'item_1', par_level: 5, par_resolved_at: expect.any(String) }])
    // (c) only these three keys — no smart_group/base_qty/etc leaking into the write.
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'par_level', 'par_resolved_at'])

    expect(result).toEqual({ properties_processed: 1, items_changed: 1 })
    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({ orgId: 'org_1', action: 'inventory.par.recomputed', targetType: 'property', targetId: 'prop_1', metadata: { items_changed: 1 } }),
    ])
  })

  it('writes nothing and skips the audit step when the resolved par equals the stored par', async () => {
    const supabase = makeSupabase({
      properties: [{ data: [property], error: null }],
      // ceil(2 * 2 * 1.15) = 5 — already at the resolved value.
      inventory_items: [
        { data: [{ id: 'item_1', par_level: 5, par_mode: 'smart', smart_group: 'bathroom_essential', base_qty: 2, auto_adjust: true }], error: null },
      ],
      inventory_consumption_stats: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(recomputeInventoryParLevels, {
      event: { data: { org_id: 'org_1' } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(supabase.calls.some((c) => c.table === 'inventory_items' && c.method === 'upsert')).toBe(false)
    expect(result).toEqual({ properties_processed: 1, items_changed: 0 })
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('is a no-op for a property with no smart items', async () => {
    const supabase = makeSupabase({
      properties: [{ data: [property], error: null }],
      inventory_items: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(recomputeInventoryParLevels, {
      event: { data: { org_id: 'org_1', property_id: 'prop_1' } },
      step:  runAllStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ properties_processed: 1, items_changed: 0 })
    expect(logAuditEvents).not.toHaveBeenCalled()
  })
})
