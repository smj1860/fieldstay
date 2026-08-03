import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { detectAndFlagOverlaps } from '@/lib/ical/conflict-detection'

/**
 * detectAndFlagOverlaps runs on EVERY feed sync (hourly, per feed) and after
 * every booking write, and it used to read the property's entire confirmed
 * booking history and compare every pair — O(n^2) over an unbounded set. A
 * five-year property with 500 bookings is ~125,000 comparisons plus a
 * full-history read, per feed, per hour.
 *
 * It is now bounded to bookings that have not already ended. These tests pin
 * that bound, and pin the overlap semantics it must NOT have changed.
 */

interface Row {
  id: string
  checkin_date: string
  checkout_date: string
  source: string | null
  guest_name: string | null
  has_overlap_conflict: boolean | null
}

function makeSupabase(rows: Row[]) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const updates: { payload: Record<string, unknown>; ids: string[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    let pendingUpdate: Record<string, unknown> | null = null

    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }

    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.gte    = (...a: unknown[]) => record('gte', a)
    chain.order  = (...a: unknown[]) => record('order', a)

    chain.update = (...a: unknown[]) => {
      pendingUpdate = a[0] as Record<string, unknown>
      return record('update', a)
    }
    chain.in = (...a: unknown[]) => {
      record('in', a)
      if (pendingUpdate) {
        updates.push({ payload: pendingUpdate, ids: a[1] as string[] })
        pendingUpdate = null
        return Promise.resolve({ data: null, error: null })
      }
      return chain
    }

    // fetchAllRows drains .range(from, to) until a short page arrives.
    chain.range = (from_: number) =>
      Promise.resolve({ data: from_ === 0 ? rows : [], error: null })

    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(res)

    return chain
  })

  return { from, calls, updates }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asClient = (s: unknown) => s as any

const NOW = Date.parse('2026-08-03T12:00:00.000Z')

function booking(over: Partial<Row> & { id: string }): Row {
  return {
    checkin_date:  '2026-08-10',
    checkout_date: '2026-08-15',
    source:        'airbnb',
    guest_name:    'Guest',
    has_overlap_conflict: false,
    ...over,
  }
}

describe('detectAndFlagOverlaps — the scan is date-bounded', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('does not read the property\'s whole booking history', async () => {
    const supabase = makeSupabase([])
    await detectAndFlagOverlaps(asClient(supabase), 'prop_1')

    const bound = supabase.calls.find(
      (c) => c.table === 'bookings' && c.method === 'gte' && c.args[0] === 'checkout_date',
    )
    expect(bound, 'the overlap scan must bound its read by date').toBeDefined()

    // Within a day of "now" — a fixed early date, or a missing bound, would
    // silently restore the full-history scan.
    const windowStart = Date.parse(`${bound!.args[1] as string}T00:00:00.000Z`)
    expect(NOW - windowStart).toBeLessThanOrEqual(2 * 24 * 60 * 60 * 1000)
    expect(windowStart).toBeLessThanOrEqual(NOW)
  })

  it('still scopes to the property and to confirmed bookings', async () => {
    const supabase = makeSupabase([])
    await detectAndFlagOverlaps(asClient(supabase), 'prop_1')

    const eqs = supabase.calls.filter((c) => c.table === 'bookings' && c.method === 'eq')
    expect(eqs.some((c) => c.args[0] === 'property_id' && c.args[1] === 'prop_1')).toBe(true)
    expect(eqs.some((c) => c.args[0] === 'status' && c.args[1] === 'confirmed')).toBe(true)
  })
})

describe('detectAndFlagOverlaps — overlap semantics are unchanged', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('flags two bookings whose ranges overlap', async () => {
    const supabase = makeSupabase([
      booking({ id: 'b1', checkin_date: '2026-08-10', checkout_date: '2026-08-15' }),
      booking({ id: 'b2', checkin_date: '2026-08-14', checkout_date: '2026-08-18' }),
    ])

    const flagged = await detectAndFlagOverlaps(asClient(supabase), 'prop_1')

    expect(flagged.map((f) => f.id).sort()).toEqual(['b1', 'b2'])
    const flagWrite = supabase.updates.find((u) => u.payload.has_overlap_conflict === true)
    expect(flagWrite?.ids.sort()).toEqual(['b1', 'b2'])
  })

  it('does NOT treat a same-day turnover as a conflict', async () => {
    const supabase = makeSupabase([
      booking({ id: 'b1', checkin_date: '2026-08-10', checkout_date: '2026-08-15' }),
      booking({ id: 'b2', checkin_date: '2026-08-15', checkout_date: '2026-08-20' }),
    ])

    const flagged = await detectAndFlagOverlaps(asClient(supabase), 'prop_1')

    expect(flagged).toHaveLength(0)
    expect(supabase.updates.some((u) => u.payload.has_overlap_conflict === true)).toBe(false)
  })

  it('clears the flag on a booking that is no longer in conflict', async () => {
    const supabase = makeSupabase([
      booking({ id: 'b1', checkin_date: '2026-08-10', checkout_date: '2026-08-15', has_overlap_conflict: true }),
      booking({ id: 'b2', checkin_date: '2026-08-20', checkout_date: '2026-08-25' }),
    ])

    await detectAndFlagOverlaps(asClient(supabase), 'prop_1')

    const clearWrite = supabase.updates.find((u) => u.payload.has_overlap_conflict === false)
    expect(clearWrite?.ids).toEqual(['b1'])
  })

  it('returns only NEWLY flagged bookings, so a known conflict does not re-alert', async () => {
    const supabase = makeSupabase([
      booking({ id: 'b1', checkin_date: '2026-08-10', checkout_date: '2026-08-15', has_overlap_conflict: true }),
      booking({ id: 'b2', checkin_date: '2026-08-14', checkout_date: '2026-08-18', has_overlap_conflict: true }),
    ])

    const flagged = await detectAndFlagOverlaps(asClient(supabase), 'prop_1')

    expect(flagged).toHaveLength(0)
  })
})
