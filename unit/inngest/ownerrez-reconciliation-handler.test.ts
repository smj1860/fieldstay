import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/ownerrez-api', () => ({
  OwnerRezApiClient: vi.fn(),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  cancelTurnoversForBookings:     vi.fn().mockResolvedValue([]),
  notifyCrewOfCancelledTurnovers: vi.fn(),
}))

import { ownerRezReconciliationHandler } from '@/lib/inngest/functions/ownerrez/reconciliation-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient } from '@/lib/integrations/providers/ownerrez-api'
import { cancelTurnoversForBookings, notifyCrewOfCancelledTurnovers } from '@/lib/turnovers/generator'
import { RateLimitError } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeAllowlistStep(allowed: string[]) {
  return {
    run: vi.fn((name: string, cb: () => unknown) => (allowed.includes(name) ? cb() : Promise.resolve(undefined))),
    sleep: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
  }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: QueuedByTable) {
  const counters: Record<string, number> = {}
  const updateSpy = vi.fn()
  const eqSpy     = vi.fn()
  const inSpy     = vi.fn()

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn((column: string, value: unknown) => { eqSpy(table, column, value); return chain })
    chain.neq    = vi.fn(() => chain)
    chain.in     = vi.fn((column: string, value: unknown) => { inSpy(table, column, value); return chain })
    chain.update = vi.fn((payload: unknown) => { updateSpy(table, payload); return chain })
    // fetch-property-ids is paginated through fetchAllRows(), which chains
    // .order().range() before awaiting.
    chain.order  = vi.fn(() => chain)
    chain.range  = vi.fn(() => chain)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = vi.fn(() => resolveNext())
    chain.maybeSingle = vi.fn(() => resolveNext())
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, updateSpy, eqSpy, inSpy }
}

function baseMocks(getBookingsImpl: () => Promise<Array<{ id: number }>>) {
  const mockClient = { getBookings: vi.fn(getBookingsImpl) }
  ;(OwnerRezApiClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
    return mockClient
  })
  return mockClient
}

describe('ownerRezReconciliationHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const ALLOWED = ['fetch-property-ids', 'fetch-current-bookings', 'cancel-stale-bookings', 'notify-crew-cancelled-turnovers']

  it('cancels a FieldStay booking (and its turnover) whose external_id no longer appears in OwnerRez\'s current full listing', async () => {
    baseMocks(async () => [{ id: 100 }])
    ;(cancelTurnoversForBookings as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
    ])

    const supabase = makeSupabase({
      properties: [{ data: [{ external_id: '42' }], error: null }],
      bookings:   [
        { data: [{ id: 'b1', external_id: '100' }, { id: 'b2', external_id: '200' }], error: null }, // select existing
        { data: [{ id: 'b2' }], error: null }, // bulk UPDATE ... RETURNING id, one row claimed
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(ALLOWED)

    const result = await invokeHandler(ownerRezReconciliationHandler, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    expect(supabase.updateSpy).toHaveBeenCalledWith('bookings', { status: 'cancelled' })
    expect(cancelTurnoversForBookings).toHaveBeenCalledWith(['b2'], supabase)
    expect(cancelTurnoversForBookings).toHaveBeenCalledTimes(1)
    expect(notifyCrewOfCancelledTurnovers).toHaveBeenCalledWith([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
    ])
    expect(result).toEqual({ cancelledCount: 1 })
  })

  it('cancels nothing when every FieldStay booking is still present in the current OwnerRez listing (no drift)', async () => {
    baseMocks(async () => [{ id: 100 }])

    const supabase = makeSupabase({
      properties: [{ data: [{ external_id: '42' }], error: null }],
      bookings:   [
        { data: [{ id: 'b1', external_id: '100' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(ALLOWED)

    const result = await invokeHandler(ownerRezReconciliationHandler, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    expect(supabase.updateSpy).not.toHaveBeenCalled()
    expect(cancelTurnoversForBookings).not.toHaveBeenCalled()
    expect(notifyCrewOfCancelledTurnovers).toHaveBeenCalledWith([])
    expect(result).toEqual({ cancelledCount: 0 })
  })

  it('refuses to cancel everything when OwnerRez returns ZERO bookings', async () => {
    baseMocks(async () => [])

    const supabase = makeSupabase({
      properties: [{ data: [{ external_id: '42' }], error: null }],
      bookings:   [
        { data: [{ id: 'b1', external_id: '100' }, { id: 'b2', external_id: '200' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezReconciliationHandler, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step:   makeAllowlistStep(ALLOWED),
      logger: makeLogger(),
    })

    // This function reconciles by ABSENCE — the only way a hard delete is
    // detectable. Its degenerate input is an empty current set: then every
    // booking in the org is absent, so the pass cancelled all of them,
    // cancelled their turnovers, and texted the crew that their jobs were off.
    // Daily, off one bad API response.
    //
    // getBookings() throws on a non-2xx, so this is the 200-with-nothing case:
    // an upstream hiccup, a propertyIds filter that stopped matching, or a
    // genuinely emptied account — indistinguishable here. The asymmetry
    // decides it: not cancelling leaves stale rows one more day; cancelling
    // wrongly sends crew home from stays that are still happening.
    expect(supabase.updateSpy).not.toHaveBeenCalled()
    expect(cancelTurnoversForBookings).not.toHaveBeenCalled()
    expect(notifyCrewOfCancelledTurnovers).not.toHaveBeenCalled()
    expect(result).toEqual({ skipped: true, reason: 'empty_current_set' })
  })

  it('skips gracefully (no throw) and never reaches cancel-stale-bookings when OwnerRez rate-limits the full listing fetch', async () => {
    baseMocks(async () => { throw new RateLimitError(30) })

    const supabase = makeSupabase({
      properties: [{ data: [{ external_id: '42' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(ALLOWED)

    const result = await invokeHandler(ownerRezReconciliationHandler, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ skipped: true, reason: 'rate_limited' })
    expect(step.run).not.toHaveBeenCalledWith('cancel-stale-bookings', expect.any(Function))
    expect(cancelTurnoversForBookings).not.toHaveBeenCalled()
    expect(notifyCrewOfCancelledTurnovers).not.toHaveBeenCalled()
  })

  it('regression: does not filter fetch-property-ids to is_active properties — a booking on a property deactivated in FieldStay but still live in OwnerRez must not look stale', async () => {
    // Previously scoped the "ask OwnerRez about these properties" query to
    // is_active = true, while cancel-stale-bookings compared against every
    // non-cancelled booking for the org with no property filter at all. A
    // booking on a deactivated property was therefore never in the "current"
    // set (its property was excluded from the OwnerRez fetch) and always
    // looked stale — getting cancelled every day, forever, even though it
    // still exists in OwnerRez. Both queries must scope to the same set of
    // properties; this asserts the properties query is unfiltered.
    baseMocks(async () => [{ id: 100 }])

    const supabase = makeSupabase({
      properties: [{ data: [{ external_id: '42' }], error: null }],
      bookings:   [
        { data: [{ id: 'b1', external_id: '100' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(ALLOWED)

    await invokeHandler(ownerRezReconciliationHandler, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    const propertiesEqCalls = supabase.eqSpy.mock.calls.filter((c) => c[0] === 'properties')
    expect(propertiesEqCalls.some((c) => c[1] === 'is_active')).toBe(false)
  })
  // ── Batching ──────────────────────────────────────────────────────────────
  //
  // This step used to do one UPDATE plus one cancelTurnoversForBooking() per
  // stale booking, sequentially. Fine at the steady-state shape (a handful of
  // hard deletes a day) and useless at the shape that actually needs it: a
  // property unlinked upstream orphans hundreds of bookings at once, the step
  // burns its execution budget on 2N round-trips, and Inngest retries from the
  // top and never reaches the tail. These two tests pin the batching so a
  // future edit cannot quietly reintroduce the per-row loop.

  it('cancels a large stale set in bounded chunks rather than one round-trip per booking', async () => {
    const STALE = 250   // > CANCEL_CHUNK (100), so this must span three chunks
    baseMocks(async () => [{ id: 1 }])

    const existing = [
      { id: 'keep', external_id: '1' },
      ...Array.from({ length: STALE }, (_, i) => ({ id: `b${i}`, external_id: `9${i}` })),
    ]

    const supabase = makeSupabase({
      properties: [{ data: [{ external_id: '42' }], error: null }],
      bookings:   [
        { data: existing, error: null },
        { data: Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` })),       error: null },
        { data: Array.from({ length: 100 }, (_, i) => ({ id: `b${i + 100}` })), error: null },
        { data: Array.from({ length: 50 },  (_, i) => ({ id: `b${i + 200}` })), error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(ownerRezReconciliationHandler, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step:   makeAllowlistStep(ALLOWED),
      logger: makeLogger(),
    })

    expect(result).toEqual({ cancelledCount: STALE })

    // Three bulk UPDATEs, not 250 — and three turnover sweeps, not 250.
    expect(supabase.updateSpy).toHaveBeenCalledTimes(3)
    expect(cancelTurnoversForBookings).toHaveBeenCalledTimes(3)

    // Every chunk is within the cap, and together they cover the whole set
    // exactly once. A chunk larger than 100 would truncate its own RETURNING
    // at max_rows and undercount; an overlap would double-cancel.
    const idBatches = (cancelTurnoversForBookings as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string[])
    expect(idBatches.map((b) => b.length)).toEqual([100, 100, 50])
    expect(new Set(idBatches.flat()).size).toBe(STALE)

    // The booking that OwnerRez still knows about is never in a cancel chunk.
    expect(idBatches.flat()).not.toContain('keep')
  })

  it('throws rather than reporting a clean run when a chunk fails to cancel', async () => {
    // The old per-booking path logged the failure and `continue`d, so a
    // booking that failed to cancel produced a SMALLER cancelledCount and an
    // otherwise successful run — indistinguishable from a booking that was
    // never stale. Nothing revisits it: the next sweep reads the same row and
    // makes the same write. Throwing gets the Inngest retry, which is safe
    // because the re-read excludes anything already cancelled.
    baseMocks(async () => [{ id: 1 }])

    const supabase = makeSupabase({
      properties: [{ data: [{ external_id: '42' }], error: null }],
      bookings:   [
        { data: [{ id: 'b1', external_id: '99' }], error: null },
        { data: null, error: { message: 'deadlock detected', code: '40P01' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(ownerRezReconciliationHandler, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step:   makeAllowlistStep(ALLOWED),
      logger: makeLogger(),
    })).rejects.toThrow(/cancel-stale-bookings \(40P01\)/)

    expect(cancelTurnoversForBookings).not.toHaveBeenCalled()
    expect(notifyCrewOfCancelledTurnovers).not.toHaveBeenCalled()
  })
})
