import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { findMaintenanceCandidatesForWindow } from '@/lib/maintenance/vacancy-suggestions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(response: Resp) {
  const calls: { method: string; args: unknown[] }[] = []
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'lte']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ method: m, args })
        return chain
      })
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(response).then(resolve)
    return chain
  })
  return { from, calls }
}

function candidate(overrides: Partial<{
  id: string; name: string; next_due_date: string; estimated_cost: number | null
  assigned_vendor_id: string | null; active_from_month: number | null; active_to_month: number | null
}> = {}) {
  return {
    id:                 'sched_1',
    name:               'Gutter cleaning',
    next_due_date:      '2026-08-01',
    estimated_cost:     150,
    assigned_vendor_id: null,
    active_from_month:  null,
    active_to_month:    null,
    ...overrides,
  }
}

describe('findMaintenanceCandidatesForWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scopes the query to the given property and active schedules only', async () => {
    const supabase = makeSupabase({ data: [], error: null })

    await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', null)

    expect(supabase.calls.some((c) => c.method === 'eq' && c.args[0] === 'property_id' && c.args[1] === 'prop_1')).toBe(true)
    expect(supabase.calls.some((c) => c.method === 'eq' && c.args[0] === 'is_active' && c.args[1] === true)).toBe(true)
  })

  it('caps the effective end date at 90 days from windowStart when windowEnd is null', async () => {
    const supabase = makeSupabase({ data: [], error: null })

    await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', null)

    const lteCall = supabase.calls.find((c) => c.method === 'lte')
    expect(lteCall?.args[0]).toBe('next_due_date')
    expect(lteCall?.args[1]).toBe('2026-10-20') // 2026-07-22 + 90 days
  })

  it('uses windowEnd directly when it falls within the 90-day lookahead cap', async () => {
    const supabase = makeSupabase({ data: [], error: null })

    await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', '2026-08-05')

    const lteCall = supabase.calls.find((c) => c.method === 'lte')
    expect(lteCall?.args[1]).toBe('2026-08-05')
  })

  it('caps the effective end date at 90 days even when windowEnd is further out', async () => {
    const supabase = makeSupabase({ data: [], error: null })

    await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', '2027-01-01')

    const lteCall = supabase.calls.find((c) => c.method === 'lte')
    expect(lteCall?.args[1]).toBe('2026-10-20')
  })

  it('returns candidates with no seasonal restriction unfiltered', async () => {
    const supabase = makeSupabase({ data: [candidate()], error: null })

    const result = await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', null)

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('sched_1')
  })

  it('filters out a candidate whose seasonal window excludes the current month', async () => {
    // System time is fixed at July (month 7). A schedule active only
    // Nov (11) – Mar (3) should be excluded.
    const supabase = makeSupabase({
      data: [candidate({ id: 'winter_only', active_from_month: 11, active_to_month: 3 })],
      error: null,
    })

    const result = await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', null)

    expect(result).toHaveLength(0)
  })

  it('keeps a candidate whose seasonal window includes the current month, including a year-wrap range', async () => {
    const supabase = makeSupabase({
      data: [
        candidate({ id: 'summer_only', active_from_month: 5, active_to_month: 9 }),
        candidate({ id: 'year_wrap_excludes_july', active_from_month: 10, active_to_month: 2 }),
      ],
      error: null,
    })

    const result = await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', null)

    expect(result.map((c) => c.id)).toEqual(['summer_only'])
  })

  it('returns an empty array when the query errors (data is null)', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'boom' } })

    const result = await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', null)

    expect(result).toEqual([])
  })

  it('preserves the shape of each returned candidate', async () => {
    const supabase = makeSupabase({
      data: [candidate({ id: 'sched_2', name: 'HVAC filter swap', estimated_cost: null, assigned_vendor_id: 'vendor_9' })],
      error: null,
    })

    const result = await findMaintenanceCandidatesForWindow(supabase as never, 'prop_1', '2026-07-22', null)

    expect(result[0]).toMatchObject({
      id: 'sched_2', name: 'HVAC filter swap', estimated_cost: null, assigned_vendor_id: 'vendor_9',
    })
  })
})
