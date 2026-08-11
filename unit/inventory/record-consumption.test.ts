import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { recordConsumptionFromCount } from '@/lib/inventory/record-consumption'

// ============================================================================
// The learning half of the PAR engine. Four decisions here are the difference
// between the engine learning something true and learning something wrong —
// and a wrong sample is worse than a missing one, because the rolling mean
// keeps it forever.
//
//   1. A RISE IS NOT NEGATIVE CONSUMPTION. If the count went up, someone
//      restocked; real consumption is (previous + restocked - current) and the
//      middle term is not recorded anywhere. The sample is unrecoverable, not
//      zero.
//   2. NO STAYS MEANS NO SAMPLE. Movement with an empty property is a PM
//      tidying or a miscount. Recording it teaches the engine that an empty
//      house consumes towels.
//   3. Read from the count SESSIONS, never inventory_items.current_quantity —
//      the sibling Inngest function overwrites that from the same event, so
//      reading it is a race that silently yields zero consumption.
//   4. The rate is per CAPACITY-night. bookings has no guest-count column, so
//      real occupancy is unobservable; dividing by max_guests keeps the round
//      trip consistent because resolvePar() multiplies by the same number.
// ============================================================================

const ORG  = 'org-1'
const PROP = 'prop-1'
const CNT  = 'count-2'

interface Resp { data: unknown; error: unknown }

/**
 * Table-keyed responses, with inventory_counts and inventory_count_items
 * queued because each is read twice (current then previous / prev items then
 * curr items).
 */
function makeSupabase(q: Record<string, Resp[]>, rpcResult: unknown = 1) {
  const idx: Record<string, number> = {}
  // Declared with its real parameters, not `() =>`. A zero-arg mock types
  // mock.calls[0] as the empty tuple, so the `calls[0][1]` reads below fail
  // tsc with TS2493 — which vitest does not catch (it never typechecks) and
  // `next build` does not either (test files are outside the app graph).
  const rpc = vi.fn((_name: string, _args: unknown) =>
    Promise.resolve({ data: rpcResult, error: null }))
  const from = vi.fn((table: string) => {
    const i = idx[table] ?? 0
    idx[table] = i + 1
    const resp = q[table]?.[i] ?? q[table]?.[q[table].length - 1] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'lt', 'gt', 'order', 'limit']) chain[m] = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => Promise.resolve(resp))
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(resp).then(res)
    return chain
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from, rpc } as any, rpc, from }
}

const CURR = { id: 'count-2', submitted_at: '2026-08-11T00:00:00Z', property_id: PROP }
const PREV = { id: 'count-1', submitted_at: '2026-08-01T00:00:00Z', property_id: PROP }
/** 5 nights inside the window, capacity 4 -> 20 capacity-nights. */
const BOOKINGS = [{ checkin_date: '2026-08-02', checkout_date: '2026-08-07' }]

function scenario(prevItems: unknown[], currItems: unknown[], bookings = BOOKINGS, maxGuests = 4) {
  return makeSupabase({
    inventory_counts:      [{ data: CURR, error: null }, { data: PREV, error: null }],
    properties:            [{ data: { max_guests: maxGuests }, error: null }],
    bookings:              [{ data: bookings, error: null }],
    inventory_count_items: [{ data: prevItems, error: null }, { data: currItems, error: null }],
  })
}

describe('recordConsumptionFromCount', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records consumption as a rate per capacity-night', async () => {
    const { client, rpc } = scenario(
      [{ inventory_item_id: 'i-1', quantity_counted: 20 }],
      [{ inventory_item_id: 'i-1', quantity_counted: 10 }],
    )
    const res = await recordConsumptionFromCount(client, { countId: CNT, propertyId: PROP, orgId: ORG })

    expect(res).toEqual({ recorded: 1 })
    const rows = (rpc.mock.calls[0][1] as { p_rows: { rate: number }[] }).p_rows
    // consumed 10 over 5 nights x 4 capacity = 20 capacity-nights -> 0.5
    expect(rows[0].rate).toBeCloseTo(0.5, 10)
  })

  it('SKIPS an item whose count went UP — that is a restock, not negative use', async () => {
    // consumed = previous + restocked - current, and restocked is recorded
    // nowhere. Treating the rise as 0 would teach the engine this item is
    // never used.
    const { client, rpc } = scenario(
      [{ inventory_item_id: 'i-1', quantity_counted: 4 }],
      [{ inventory_item_id: 'i-1', quantity_counted: 30 }],
    )
    await expect(recordConsumptionFromCount(client, { countId: CNT, propertyId: PROP, orgId: ORG }))
      .resolves.toEqual({ recorded: 0, reason: 'no_positive_deltas' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('SKIPS an item whose count is UNCHANGED — 0 is not an observation of zero use', async () => {
    // A flat count usually means the crew restocked back to par between the
    // two sessions, not that guests used none. Recording it as rate 0 drags
    // the rolling mean toward "never consumed", and the mean keeps it forever.
    // This is the case a `consumed < 0` guard lets through while a
    // `consumed <= 0` guard catches — the two are indistinguishable on a
    // restock-shaped fixture alone.
    const { client, rpc } = scenario(
      [{ inventory_item_id: 'i-1', quantity_counted: 12 }],
      [{ inventory_item_id: 'i-1', quantity_counted: 12 }],
    )
    await expect(recordConsumptionFromCount(client, { countId: CNT, propertyId: PROP, orgId: ORG }))
      .resolves.toEqual({ recorded: 0, reason: 'no_positive_deltas' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('records nothing when no stays happened between the counts', async () => {
    // Stock moved with an empty property: a PM tidying, a crew restock, a
    // miscount. Not guest consumption.
    const { client, rpc } = scenario(
      [{ inventory_item_id: 'i-1', quantity_counted: 20 }],
      [{ inventory_item_id: 'i-1', quantity_counted: 10 }],
      [],
    )
    await expect(recordConsumptionFromCount(client, { countId: CNT, propertyId: PROP, orgId: ORG }))
      .resolves.toEqual({ recorded: 0, reason: 'no_occupied_nights' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('records nothing on the very first count — there is nothing to diff', async () => {
    const client = makeSupabase({
      inventory_counts: [{ data: CURR, error: null }, { data: null, error: null }],
    }).client
    await expect(recordConsumptionFromCount(client, { countId: CNT, propertyId: PROP, orgId: ORG }))
      .resolves.toEqual({ recorded: 0, reason: 'no_previous_count' })
  })

  it('ignores an item that was not counted last time', async () => {
    // Newly added to the property mid-window: no baseline, so no diff.
    const { client, rpc } = scenario(
      [{ inventory_item_id: 'i-1', quantity_counted: 20 }],
      [{ inventory_item_id: 'i-1', quantity_counted: 10 },
       { inventory_item_id: 'i-new', quantity_counted: 3 }],
    )
    await recordConsumptionFromCount(client, { countId: CNT, propertyId: PROP, orgId: ORG })
    const rows = (rpc.mock.calls[0][1] as { p_rows: { inventory_item_id: string }[] }).p_rows
    expect(rows.map((r) => r.inventory_item_id)).toEqual(['i-1'])
  })

  it('clamps booking overlap to the window between the two counts', async () => {
    // A stay spanning far outside the window must contribute only its nights
    // INSIDE it, or the rate is divided by time the drop did not cover.
    const { client, rpc } = scenario(
      [{ inventory_item_id: 'i-1', quantity_counted: 20 }],
      [{ inventory_item_id: 'i-1', quantity_counted: 10 }],
      [{ checkin_date: '2026-07-01', checkout_date: '2026-09-01' }],
    )
    await recordConsumptionFromCount(client, { countId: CNT, propertyId: PROP, orgId: ORG })
    const rows = (rpc.mock.calls[0][1] as { p_rows: { rate: number }[] }).p_rows
    // Window is Aug 1 -> Aug 11 = 10 nights, x4 capacity = 40. 10/40 = 0.25.
    expect(rows[0].rate).toBeCloseTo(0.25, 10)
  })

  it('never reads inventory_items — the sibling handler overwrites it', async () => {
    const { client, from } = scenario(
      [{ inventory_item_id: 'i-1', quantity_counted: 20 }],
      [{ inventory_item_id: 'i-1', quantity_counted: 10 }],
    )
    await recordConsumptionFromCount(client, { countId: CNT, propertyId: PROP, orgId: ORG })
    expect(from.mock.calls.map((c) => c[0])).not.toContain('inventory_items')
  })
})
