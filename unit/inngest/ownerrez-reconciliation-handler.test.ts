import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/ownerrez-api', () => ({
  OwnerRezApiClient: vi.fn(),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  cancelTurnoversForBooking: vi.fn(),
}))

import { ownerRezReconciliationHandler } from '@/lib/inngest/functions/ownerrez/reconciliation-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient } from '@/lib/integrations/providers/ownerrez-api'
import { cancelTurnoversForBooking } from '@/lib/turnovers/generator'
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

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn((column: string, value: unknown) => { eqSpy(table, column, value); return chain })
    chain.neq    = vi.fn(() => chain)
    chain.update = vi.fn((payload: unknown) => { updateSpy(table, payload); return chain })

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

  return { from, updateSpy, eqSpy }
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

  const ALLOWED = ['fetch-property-ids', 'fetch-current-bookings', 'cancel-stale-bookings']

  it('cancels a FieldStay booking (and its turnover) whose external_id no longer appears in OwnerRez\'s current full listing', async () => {
    baseMocks(async () => [{ id: 100 }])

    const supabase = makeSupabase({
      properties: [{ data: [{ external_id: '42' }], error: null }],
      bookings:   [
        { data: [{ id: 'b1', external_id: '100' }, { id: 'b2', external_id: '200' }], error: null }, // select existing
        { data: null, error: null }, // update on b2
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
    expect(cancelTurnoversForBooking).toHaveBeenCalledWith('b2', supabase)
    expect(cancelTurnoversForBooking).toHaveBeenCalledTimes(1)
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
    expect(cancelTurnoversForBooking).not.toHaveBeenCalled()
    expect(result).toEqual({ cancelledCount: 0 })
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
    expect(cancelTurnoversForBooking).not.toHaveBeenCalled()
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
})
