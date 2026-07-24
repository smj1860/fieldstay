import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { turnoverPriorityDecay } from '@/lib/inngest/functions/cron/turnover-priority-decay'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and vendor-compliance-grace-check. `turnovers` is queried once up front
// (candidates) and then again per-candidate for the update, so a fixed
// per-table response isn't enough.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.gte    = (...a: unknown[]) => record('gte', a)
    chain.lte    = (...a: unknown[]) => record('lte', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.update = (...a: unknown[]) => record('update', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('turnoverPriorityDecay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when there are no standalone medium-priority turnovers', async () => {
    const supabase = makeSupabase({
      turnovers: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(turnoverPriorityDecay, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 0, downgraded: 0 })
    expect(supabase.calls.some((c) => c.method === 'update')).toBe(false)
  })

  it('downgrades a standalone turnover to low priority when no booking is coming within the window', async () => {
    const supabase = makeSupabase({
      turnovers: [
        {
          data: [
            { id: 'to_1', property_id: 'prop_1', checkout_datetime: '2026-07-25T15:00:00.000Z' },
          ],
          error: null,
        },
      ],
      bookings: [
        { data: [], error: null }, // no upcoming bookings for any candidate property
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(turnoverPriorityDecay, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 1, downgraded: 1 })

    const updateCall = supabase.calls.find((c) => c.table === 'turnovers' && c.method === 'update')
    expect(updateCall?.args[0]).toEqual({ priority: 'low' })

    // Batched downgrade (.in on ids) + optimistic lock — the update is scoped
    // to priority='medium' so a concurrent manual override between the check
    // and this write isn't clobbered.
    const laterCalls = supabase.calls.filter(
      (c) => c.table === 'turnovers' && supabase.calls.indexOf(c) > supabase.calls.indexOf(updateCall!)
    )
    expect(laterCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'in', args: ['id', ['to_1']] }),
        expect.objectContaining({ method: 'eq', args: ['priority', 'medium'] }),
      ]),
    )
  })

  it('does not downgrade when an upcoming booking exists within the no-booking window', async () => {
    const supabase = makeSupabase({
      turnovers: [
        {
          data: [
            { id: 'to_2', property_id: 'prop_2', checkout_datetime: '2026-07-25T15:00:00.000Z' },
          ],
          error: null,
        },
      ],
      bookings: [
        // an upcoming booking exists within the 14-day window
        { data: [{ property_id: 'prop_2', checkin_date: '2026-07-30' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(turnoverPriorityDecay, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 1, downgraded: 0 })
    expect(supabase.calls.some((c) => c.method === 'update')).toBe(false)
  })

  it('downgrades only the turnovers whose own window lacks a booking when candidates share a batch', async () => {
    const supabase = makeSupabase({
      turnovers: [
        {
          data: [
            { id: 'to_a', property_id: 'prop_a', checkout_datetime: '2026-07-25T15:00:00.000Z' },
            { id: 'to_b', property_id: 'prop_b', checkout_datetime: '2026-07-25T15:00:00.000Z' },
          ],
          error: null,
        },
      ],
      bookings: [
        // prop_b has a booking in window; prop_a has none
        { data: [{ property_id: 'prop_b', checkin_date: '2026-08-01' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(turnoverPriorityDecay, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 2, downgraded: 1 })
    const inCall = supabase.calls.find((c) => c.table === 'turnovers' && c.method === 'in')
    expect(inCall?.args).toEqual(['id', ['to_a']])
  })
})
