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

describe('cancelTurnoversForBooking', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the assigned crew member for a single cancelled turnover', async () => {
    const supabase = makeSupabase({
      data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: [{ crew_member_id: 'crew_1' }] }],
      error: null,
    })

    const result = await cancelTurnoversForBooking('booking_1', supabase as never)

    expect(result).toEqual([{ turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' }])
  })

  it('flattens the reverse-FK object shape (non-array embed) the same as the array shape', async () => {
    const supabase = makeSupabase({
      data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: { crew_member_id: 'crew_1' } }],
      error: null,
    })

    const result = await cancelTurnoversForBooking('booking_1', supabase as never)

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

    const result = await cancelTurnoversForBooking('booking_1', supabase as never)

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

    const result = await cancelTurnoversForBooking('booking_1', supabase as never)

    expect(result).toEqual([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
      { turnoverId: 'to_2', orgId: 'org_1', crewMemberId: 'crew_1' },
    ])
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
