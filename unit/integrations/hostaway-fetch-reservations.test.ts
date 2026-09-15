import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  hostawayFetchReservations,
  HostawayPaginationOverflowError,
} from '@/lib/integrations/providers/hostaway'
import { hostawayHistoryCutoff } from '@/lib/inngest/functions/hostaway/reservation-sync'

// ============================================================================
// hostawayFetchReservations is paginated with no local test coverage — the
// existing sync-level tests mock this function out entirely. Two real
// defects lived only here:
//
//   1. A MAX_PAGES overflow threw a generic Error, indistinguishable from a
//      transient network blip to every caller.
//   2. Unlike hostawayFetchReviews (sortBy: 'id' + sortOrder: 'asc'), this
//      endpoint gets only a single sortOrder column name with no proven
//      page-to-page stability — an offset walk over a set the API is free to
//      reorder can repeat rows across a page boundary.
// ============================================================================

function jsonResponse(result: unknown[]): Response {
  return new Response(JSON.stringify({ status: 'success', result }), { status: 200 })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hostawayFetchReservations', () => {
  it('dedupes reservations that appear on more than one page', async () => {
    // LIMIT is 100, and only a page shorter than LIMIT ends the walk — so
    // page 1 must be full-sized for the loop to request a page 2 at all.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    // id 99 repeats as the first row of page 2 — exactly what an unstable
    // offset walk produces when the underlying set shifts mid-walk.
    const page2 = [{ id: 99 }, { id: 100 }]
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock
      .mockImplementationOnce(async () => jsonResponse(page1))
      .mockImplementationOnce(async () => jsonResponse(page2))

    const result = await hostawayFetchReservations('token', { kind: 'arrivalFrom', date: '2026-01-01' })

    expect(result).toHaveLength(101)
    expect(result.filter((r) => r.id === 99)).toHaveLength(1)
  })

  it('throws a distinguishable HostawayPaginationOverflowError past MAX_PAGES, not a generic Error', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    // Every page full (100 rows) so the loop never sees a short page and
    // keeps paginating until it trips MAX_PAGES. A fresh Response per call —
    // a single shared instance's body can only be consumed once.
    fetchMock.mockImplementation(async () =>
      jsonResponse(Array.from({ length: 100 }, (_, i) => ({ id: i }))),
    )

    await expect(
      hostawayFetchReservations('token', { kind: 'arrivalFrom', date: '2026-01-01' }),
    ).rejects.toBeInstanceOf(HostawayPaginationOverflowError)
  })
})

describe('hostawayHistoryCutoff', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not overflow into a later month when "today" is the 31st of a longer month', () => {
    // Date.setMonth() leaves day-of-month unchanged; 1 month back from
    // 2027-03-31 targets February, which has no 31st in a non-leap year, so
    // an un-pinned setMonth() rolls FORWARD to March 3 — narrowing "one month
    // back" to ~29 days instead of widening it.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-03-31T12:00:00Z'))

    const cutoff = hostawayHistoryCutoff(1)

    expect(cutoff.startsWith('2027-03')).toBe(false)
    expect(cutoff <= '2027-02-28').toBe(true)
  })

  it('always rounds down to the 1st of the target month, even on an ordinary day', () => {
    // The fix pins to day 1 unconditionally before subtracting the month —
    // a very slightly wider window every day, in exchange for never silently
    // narrowing it on the 29th-31st of a source month whose target is shorter.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-06-15T12:00:00Z'))

    expect(hostawayHistoryCutoff(1)).toBe('2027-05-01')
  })
})
