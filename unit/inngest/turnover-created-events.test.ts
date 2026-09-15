import { describe, it, expect } from 'vitest'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'

// ============================================================================
// PostgREST encodes `.in()` values straight into the query string, so an
// unbounded id array eventually produces a URL past a proxy's length limit
// and the request itself fails with a 414 — REQUEST-side, distinct from the
// response-side max_rows=1000 truncation this file's pagination already
// guards against. A first-time PMS sync routinely produces thousands of
// `turnoverIds` in one call, so the `.in('id', turnoverIds)` filter itself
// has to be chunked, not just the response.
// ============================================================================

interface TurnoverRow {
  id: string
  property_id: string
  checkout_datetime: string
  checkin_datetime: string
  window_minutes: number | null
}

/** Records every `.in('id', …)` list the code under test actually sent. */
function makeSupabase(allRows: TurnoverRow[]) {
  const inCalls: string[][] = []

  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain,
    in: (_col: string, ids: string[]) => {
      inCalls.push(ids)
      return chain
    },
    order: () => chain,
    range: (from: number, to: number) => {
      const ids = inCalls[inCalls.length - 1]!
      const matched = allRows.filter((r) => ids.includes(r.id))
      return Promise.resolve({ data: matched.slice(from, to + 1), error: null })
    },
  })

  const supabase = { from: () => chain } as never
  return { supabase, inCalls }
}

function makeTurnover(id: string): TurnoverRow {
  return {
    id,
    property_id:       'prop-1',
    checkout_datetime: '2026-09-15T11:00:00Z',
    checkin_datetime:  '2026-09-15T16:00:00Z',
    window_minutes:    300,
  }
}

describe('fetchTurnoverCreatedEvents', () => {
  it('returns [] without querying when given no ids', async () => {
    const { supabase, inCalls } = makeSupabase([])
    const events = await fetchTurnoverCreatedEvents(supabase, [], 'org-1')
    expect(events).toEqual([])
    expect(inCalls).toHaveLength(0)
  })

  it('builds one turnover/created event per id, for a small list', async () => {
    const ids  = ['t1', 't2', 't3']
    const rows = ids.map(makeTurnover)
    const { supabase } = makeSupabase(rows)

    const events = await fetchTurnoverCreatedEvents(supabase, ids, 'org-1')

    expect(events).toHaveLength(3)
    expect(events.map((e) => e.data.turnover_id).sort()).toEqual(ids)
    expect(events[0]).toMatchObject({
      name: 'turnover/created',
      data: { org_id: 'org-1', property_id: 'prop-1', window_minutes: 300 },
    })
  })

  it('never sends an .in() list larger than the chunk size', async () => {
    // The exact scenario this guards: an initial PMS sync generating one
    // turnover per historical stay, routinely thousands on a first sync.
    const ids  = Array.from({ length: 2_450 }, (_, i) => `t${i}`)
    const rows = ids.map(makeTurnover)
    const { supabase, inCalls } = makeSupabase(rows)

    const events = await fetchTurnoverCreatedEvents(supabase, ids, 'org-1')

    expect(events).toHaveLength(2_450)
    expect(inCalls.length).toBeGreaterThan(1)
    for (const call of inCalls) {
      expect(call.length).toBeLessThanOrEqual(100)
    }
    // Every id still reachable, none dropped or duplicated by the chunking.
    expect(new Set(events.map((e) => e.data.turnover_id)).size).toBe(2_450)
  })

  it('handles an id count that is an exact multiple of the chunk size', async () => {
    const ids  = Array.from({ length: 300 }, (_, i) => `t${i}`)
    const rows = ids.map(makeTurnover)
    const { supabase, inCalls } = makeSupabase(rows)

    const events = await fetchTurnoverCreatedEvents(supabase, ids, 'org-1')

    expect(events).toHaveLength(300)
    expect(inCalls).toHaveLength(3)
    expect(inCalls.every((c) => c.length === 100)).toBe(true)
  })
})
