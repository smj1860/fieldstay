import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { recomputeParLevels } from '@/lib/inventory/recompute-par'

// ============================================================================
// PAR pass 2. Three things here are load-bearing and fail quietly:
//
//   1. STATIC ITEMS ARE NEVER TOUCHED. par_mode='static' means the PM typed
//      that number. Overwriting it is the single worst thing this function
//      could do, and nothing in the UI would explain where their value went.
//      Enforced by the query filter, so the test asserts the filter.
//
//   2. The write goes through the RPC, not .upsert(). A partial-row upsert is
//      rejected by NOT NULL before conflict detection (verified against the
//      live DB: 23502), so that shape makes the whole engine inert while
//      reporting success.
//
//   3. Properties with missing size metadata still resolve. bedrooms/
//      bathrooms/max_guests are all nullable and several live rows are 0 — a
//      property nobody finished setting up still needs towels.
// ============================================================================

interface Resp { data: unknown; error: unknown }

function makeSupabase(byTable: Record<string, Resp>, rpcResult: unknown = 3) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const rpc = vi.fn((name: string, args: unknown) => {
    calls.push({ table: '__rpc__', method: name, args: [args] })
    return Promise.resolve({ data: rpcResult, error: null })
  })
  const from = vi.fn((table: string) => {
    const resp = byTable[table] ?? { data: [], error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'limit']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ table, method: m, args }); return chain })
    }
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(resp).then(res)
    return chain
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from, rpc } as any, calls, rpc }
}

const ORG = 'org-1'
const PROPS = [
  { id: 'p-big',   bedrooms: 4, bathrooms: 3, max_guests: 10, avg_stay_length: null },
  { id: 'p-small', bedrooms: 1, bathrooms: 1, max_guests: 2,  avg_stay_length: null },
]
/** Bath Towels: guest_consumable, 2 per guest, +10% buffer. */
const TOWELS = (propertyId: string, id: string) => ({
  id, property_id: propertyId, par_mode: 'smart', smart_group: 'guest_consumable',
  base_qty: 2, par_level: 14, auto_adjust: true,
})

describe('recomputeParLevels', () => {
  beforeEach(() => vi.clearAllMocks())

  it('scales the same item differently per property', async () => {
    const { client, rpc } = makeSupabase({
      properties:                   { data: PROPS, error: null },
      inventory_items:              { data: [TOWELS('p-big', 'i-1'), TOWELS('p-small', 'i-2')], error: null },
      inventory_consumption_stats:  { data: [], error: null },
    })

    const res = await recomputeParLevels(client, { orgId: ORG })

    expect(res).toEqual({ properties: 2, resolved: 2, changed: 3 })
    const rows = (rpc.mock.calls[0][1] as { p_rows: { id: string; par_level: number }[] }).p_rows
    // 10 guests: ceil(2 * 10 * 1.10) = 22.   2 guests: ceil(2 * 2 * 1.10) = 5.
    expect(rows).toEqual([{ id: 'i-1', par_level: 22 }, { id: 'i-2', par_level: 5 }])
  })

  it('only ever reads smart items — a static par is the PM\'s own number', async () => {
    const { client, calls } = makeSupabase({
      properties:                  { data: PROPS, error: null },
      inventory_items:             { data: [TOWELS('p-big', 'i-1')], error: null },
      inventory_consumption_stats: { data: [], error: null },
    })
    await recomputeParLevels(client, { orgId: ORG })

    const itemFilters = calls.filter((c) => c.table === 'inventory_items' && c.method === 'eq')
    expect(itemFilters).toContainEqual(expect.objectContaining({ args: ['par_mode', 'smart'] }))
    expect(itemFilters).toContainEqual(expect.objectContaining({ args: ['org_id', ORG] }))
  })

  it('writes through the RPC, never an upsert', async () => {
    const { client, rpc, calls } = makeSupabase({
      properties:                  { data: PROPS, error: null },
      inventory_items:             { data: [TOWELS('p-big', 'i-1')], error: null },
      inventory_consumption_stats: { data: [], error: null },
    })
    await recomputeParLevels(client, { orgId: ORG })

    expect(rpc).toHaveBeenCalledWith('apply_resolved_par_levels', expect.any(Object))
    expect(calls.some((c) => c.method === 'upsert')).toBe(false)
  })

  it('still resolves a property with no size metadata', async () => {
    // 0/null means "nobody filled this in", not "this property sleeps zero".
    const { client, rpc } = makeSupabase({
      properties: { data: [{ id: 'p-blank', bedrooms: 0, bathrooms: null, max_guests: 0, avg_stay_length: null }], error: null },
      inventory_items:             { data: [TOWELS('p-blank', 'i-9')], error: null },
      inventory_consumption_stats: { data: [], error: null },
    })
    await recomputeParLevels(client, { orgId: ORG })
    const rows = (rpc.mock.calls[0][1] as { p_rows: { par_level: number }[] }).p_rows
    // Falls back to 2 guests: ceil(2 * 2 * 1.10) = 5. Never 0.
    expect(rows[0].par_level).toBe(5)
  })

  it('prefers historical consumption once enough samples exist', async () => {
    const { client, rpc } = makeSupabase({
      properties:      { data: [{ id: 'p-big', bedrooms: 4, bathrooms: 3, max_guests: 10, avg_stay_length: 3 }], error: null },
      inventory_items: { data: [TOWELS('p-big', 'i-1')], error: null },
      inventory_consumption_stats: {
        data: [{ inventory_item_id: 'i-1', avg_rate_per_guest_night: 0.5, sample_count: 5 }],
        error: null,
      },
    })
    await recomputeParLevels(client, { orgId: ORG })
    const rows = (rpc.mock.calls[0][1] as { p_rows: { par_level: number }[] }).p_rows
    // 0.5 * 10 guests * 3 nights = 15, +20% buffer = 18 — not the formula's 22.
    expect(rows[0].par_level).toBe(18)
  })

  it('does no work and no write when the org has no properties', async () => {
    const { client, rpc } = makeSupabase({ properties: { data: [], error: null } })
    await expect(recomputeParLevels(client, { orgId: ORG }))
      .resolves.toEqual({ properties: 0, resolved: 0, changed: 0 })
    expect(rpc).not.toHaveBeenCalled()
  })
})
