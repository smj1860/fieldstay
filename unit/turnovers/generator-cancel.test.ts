import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))

import { inngest } from '@/lib/inngest/client'
import { cancelTurnoversForBooking, notifyCrewOfCancelledTurnovers } from '@/lib/turnovers/generator'

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
