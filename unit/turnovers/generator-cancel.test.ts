import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))

import { inngest } from '@/lib/inngest/client'
import { cancelTurnoversForBooking, cancelTurnoversForBookings, notifyCrewOfCancelledTurnovers } from '@/lib/turnovers/generator'

// Queue-based `.from(table)` mock: cancelTurnoversForBooking now makes a
// single atomic .update().select() call against 'turnovers' — an
// UPDATE ... RETURNING, not a separate SELECT-then-UPDATE — so there's
// exactly one response to queue per test.
function makeSupabase(response: { data?: unknown; error?: unknown }) {
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = () => chain
    chain.select = record
    chain.update = record
    chain.or     = record
    chain.eq     = record
    chain.in     = record
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(response).then(resolve)
    return chain
  })
  return { from }
}

// cancelTurnoversForBooking splices bookingId into a PostgREST `.or()` filter
// expression, which is parsed server-side rather than bound as a parameter, so
// it now refuses anything that is not a uuid. Real ids are uuids — every caller
// reads them back from our own bookings table — so the fixtures use one too.
const BOOKING_ID = '11111111-2222-4333-8444-555555555555'

describe('cancelTurnoversForBooking', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the assigned crew member for a single cancelled turnover', async () => {
    const supabase = makeSupabase({
      data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: [{ crew_member_id: 'crew_1' }] }],
      error: null,
    })

    const result = await cancelTurnoversForBooking(BOOKING_ID, supabase as never)

    expect(result).toEqual([{ turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' }])
  })

  it('flattens the reverse-FK object shape (non-array embed) the same as the array shape', async () => {
    const supabase = makeSupabase({
      data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: { crew_member_id: 'crew_1' } }],
      error: null,
    })

    const result = await cancelTurnoversForBooking(BOOKING_ID, supabase as never)

    expect(result).toEqual([{ turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' }])
  })

  it('returns nothing for a booking whose affected turnovers were never assigned', async () => {
    // A 'pending_assignment' turnover has no turnover_assignments rows to
    // embed, regardless of matching the .in('status', [...]) update filter
    // — unwrapJoinArray sees an empty/null embed and contributes nothing.
    const supabase = makeSupabase({
      data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: [] }],
      error: null,
    })

    const result = await cancelTurnoversForBooking(BOOKING_ID, supabase as never)

    expect(result).toEqual([])
  })

  it('returns one entry per crew member across multiple affected turnovers', async () => {
    const supabase = makeSupabase({
      data: [
        { id: 'to_1', org_id: 'org_1', turnover_assignments: [{ crew_member_id: 'crew_1' }] },
        { id: 'to_2', org_id: 'org_1', turnover_assignments: [{ crew_member_id: 'crew_1' }] },
      ],
      error: null,
    })

    const result = await cancelTurnoversForBooking(BOOKING_ID, supabase as never)

    expect(result).toEqual([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
      { turnoverId: 'to_2', orgId: 'org_1', crewMemberId: 'crew_1' },
    ])
  })

  // A discarded error returned [] — indistinguishable from "nothing needed
  // cancelling". The booking is cancelled, its turnovers stay assigned, and
  // notifyCrewOfCancelledTurnovers gets an empty list, so nobody is told. A
  // crew member turns up to clean a stay that is not happening. Every caller
  // runs this inside step.run(), so throwing gets the retry it deserves.
  it('throws rather than reporting "nothing cancelled" when the UPDATE fails', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'deadlock detected', code: '40P01' } })

    await expect(cancelTurnoversForBooking(BOOKING_ID, supabase as never))
      .rejects.toThrow(/deadlock detected/)
  })

  // `.or()` takes a filter EXPRESSION, not bound parameters, so a value with a
  // comma or a PostgREST operator would add clauses instead of being matched
  // literally. Not currently reachable — every caller passes an id read back
  // from our own bookings table — but nothing in the type system says so.
  it.each([
    ['a comma-smuggled clause', 'x,status.eq.completed'],
    ['a bare operator',         'eq.anything'],
    ['an empty string',         ''],
    ['a plain label',           'booking_1'],
  ])('refuses %s rather than splicing it into the filter', async (_label, value) => {
    const supabase = makeSupabase({ data: [], error: null })

    await expect(cancelTurnoversForBooking(value, supabase as never))
      .rejects.toThrow(/not a uuid/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

})

// ── The set-taking form ─────────────────────────────────────────────────────
//
// cancelTurnoversForBookings IS the implementation; the single-booking export
// above delegates to it with a one-element array. It exists because ownerrez's
// reconciliation sweep called the single form once per stale booking, so a
// provider hiccup that orphaned hundreds of bookings did hundreds of
// sequential round-trips inside one Inngest step and never finished.
//
// A batching fix that is not pinned by a test is a batching fix that reverts:
// setting the chunk to 1 restores the exact defect and every OTHER test in
// this file still passes, because they all use one booking.
describe('cancelTurnoversForBookings', () => {
  beforeEach(() => vi.clearAllMocks())

  // Records every call so the number of statements — the whole point — is
  // observable, and captures the .or() filter each one was given.
  function makeCountingSupabase(responses: Array<{ data?: unknown; error?: unknown }>) {
    const orFilters: string[] = []
    let call = 0
    const from = vi.fn(() => {
      const idx = call++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      const record = () => chain
      chain.select = record
      chain.update = record
      chain.eq     = record
      chain.in     = record
      chain.or     = vi.fn((filter: string) => { orFilters.push(filter); return chain })
      chain.then   = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(responses[idx] ?? { data: [], error: null }).then(resolve)
      return chain
    })
    return { from, orFilters, callCount: () => call }
  }

  function uuid(n: number) {
    return `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`
  }

  it('issues nothing at all for an empty set', async () => {
    const supabase = makeCountingSupabase([])
    const result = await cancelTurnoversForBookings([], supabase as never)

    expect(result).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('collapses a chunk of bookings into ONE statement, not one per booking', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => uuid(i))
    const supabase = makeCountingSupabase([{ data: [], error: null }])

    await cancelTurnoversForBookings(ids, supabase as never)

    expect(supabase.callCount()).toBe(1)
  })

  it('splits a set larger than the chunk, covering every booking exactly once', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i))
    const supabase = makeCountingSupabase([
      { data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: [{ crew_member_id: 'crew_1' }] }], error: null },
      { data: [], error: null },
      { data: [{ id: 'to_2', org_id: 'org_1', turnover_assignments: [{ crew_member_id: 'crew_2' }] }], error: null },
    ])

    const result = await cancelTurnoversForBookings(ids, supabase as never)

    // 250 bookings, 3 statements — the pre-fix shape was 250.
    expect(supabase.callCount()).toBe(3)

    // Results accumulate across chunks. A `return` where a push belongs would
    // silently drop every crew member after the first chunk.
    expect(result).toEqual([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
      { turnoverId: 'to_2', orgId: 'org_1', crewMemberId: 'crew_2' },
    ])

    // Both columns are matched with a single `in.()` term each, so the filter
    // stays two terms wide regardless of set size. A chain of per-id `eq`s
    // would grow the expression linearly and blow the request line.
    for (const filter of supabase.orFilters) {
      expect(filter).toMatch(/^booking_id\.in\.\([^)]+\),prev_booking_id\.in\.\([^)]+\)$/)
    }

    const covered = supabase.orFilters.flatMap((f) => {
      const inner = /^booking_id\.in\.\(([^)]+)\)/.exec(f)
      return inner ? inner[1].split(',') : []
    })
    expect(covered).toEqual(ids)          // in order, no gaps
    expect(new Set(covered).size).toBe(250)  // and no overlaps
  })

  it('validates EVERY id before issuing any statement, so one bad element cannot ride along in a chunk', async () => {
    const supabase = makeCountingSupabase([{ data: [], error: null }])

    await expect(
      cancelTurnoversForBookings([uuid(1), 'x,status.eq.completed', uuid(2)], supabase as never)
    ).rejects.toThrow(/not a uuid/)

    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('throws on a chunk failure rather than returning the chunks that did succeed', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => uuid(i))
    const supabase = makeCountingSupabase([
      { data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: [{ crew_member_id: 'crew_1' }] }], error: null },
      { data: null, error: { message: 'deadlock detected', code: '40P01' } },
    ])

    // Returning a partial list would be worse than throwing: the caller passes
    // it to notifyCrewOfCancelledTurnovers, so the crew on the failed chunk are
    // never told their jobs are off while the run reports success.
    await expect(cancelTurnoversForBookings(ids, supabase as never))
      .rejects.toThrow(/deadlock detected/)
  })
})

describe('notifyCrewOfCancelledTurnovers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does nothing when there is nothing cancelled', async () => {
    await notifyCrewOfCancelledTurnovers([])
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('fires exactly one event for a single cancelled turnover', async () => {
    await notifyCrewOfCancelledTurnovers([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
    ])

    expect(inngest.send).toHaveBeenCalledTimes(1)
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'turnover/cancelled',
      data: { crew_member_id: 'crew_1', turnover_ids: ['to_1'], org_id: 'org_1' },
    })
  })

  it('batches two turnovers cancelled for the same crew member into a single event', async () => {
    await notifyCrewOfCancelledTurnovers([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
      { turnoverId: 'to_2', orgId: 'org_1', crewMemberId: 'crew_1' },
    ])

    expect(inngest.send).toHaveBeenCalledTimes(1)
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'turnover/cancelled',
      data: { crew_member_id: 'crew_1', turnover_ids: ['to_1', 'to_2'], org_id: 'org_1' },
    })
  })

  it('fires one event per distinct crew member when different crew are affected', async () => {
    await notifyCrewOfCancelledTurnovers([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
      { turnoverId: 'to_2', orgId: 'org_1', crewMemberId: 'crew_2' },
    ])

    expect(inngest.send).toHaveBeenCalledTimes(2)
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'turnover/cancelled',
      data: { crew_member_id: 'crew_1', turnover_ids: ['to_1'], org_id: 'org_1' },
    })
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'turnover/cancelled',
      data: { crew_member_id: 'crew_2', turnover_ids: ['to_2'], org_id: 'org_1' },
    })
  })
})
