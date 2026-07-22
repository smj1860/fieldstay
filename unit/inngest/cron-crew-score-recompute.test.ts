import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { crewScoreRecompute } from '@/lib/inngest/functions/cron/crew-score-recompute'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

interface TurnoverRow {
  id:                    string
  org_id:                string
  turnover_assignments:  { crew_member_id: string }[]
}

function makeSupabase(opts: {
  turnovers:        { data: TurnoverRow[] | null; error: null }
  upsert?:          { error: { message: string } | null }
  rpc?:             { data: unknown; error: { message: string } | null }
}) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.lt     = (...a: unknown[]) => record('lt', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (table === 'turnovers')            return Promise.resolve(opts.turnovers).then(resolve, reject)
      if (table === 'assignment_outcomes')   return Promise.resolve(opts.upsert ?? { error: null }).then(resolve, reject)
      return Promise.resolve({ data: null, error: null }).then(resolve, reject)
    }
    return chain
  })

  const rpc = vi.fn(async (_fn: string) => opts.rpc ?? { data: { scored: 0, crewUpdated: 0, capacityUpdated: 0 }, error: null })

  return { from, rpc, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const logger = { info: vi.fn(), error: vi.fn() }

describe('crewScoreRecompute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flags missed assignments, upserts them, and folds the RPC score deltas into the result', async () => {
    const supabase = makeSupabase({
      turnovers: {
        data: [
          {
            id: 'to_1', org_id: 'org_1',
            turnover_assignments: [{ crew_member_id: 'c1' }, { crew_member_id: 'c2' }],
          },
        ],
        error: null,
      },
      upsert: { error: null },
      rpc:    { data: { scored: 5, crewUpdated: 3, capacityUpdated: 2 }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(crewScoreRecompute, { event: {}, step: makeStep(), logger })

    expect(result).toEqual({ flagged: 2, scored: 5, crewUpdated: 3, capacityUpdated: 2 })

    const upsertCall = supabase.calls.find((c) => c.table === 'assignment_outcomes' && c.method === 'upsert')
    expect(upsertCall?.args[0]).toEqual([
      { turnover_id: 'to_1', org_id: 'org_1', crew_member_id: 'c1', was_missed: true },
      { turnover_id: 'to_1', org_id: 'org_1', crew_member_id: 'c2', was_missed: true },
    ])
    expect(upsertCall?.args[1]).toEqual({ onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: false })

    expect(supabase.rpc).toHaveBeenCalledWith('apply_crew_score_recompute')
  })

  it('is a no-op on the flagging side when no turnover is past checkout without completion', async () => {
    const supabase = makeSupabase({
      turnovers: { data: [], error: null },
      rpc:       { data: { scored: 0, crewUpdated: 0, capacityUpdated: 0 }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(crewScoreRecompute, { event: {}, step: makeStep(), logger })

    expect(result).toEqual({ flagged: 0, scored: 0, crewUpdated: 0, capacityUpdated: 0 })
    expect(supabase.calls.some((c) => c.table === 'assignment_outcomes' && c.method === 'upsert')).toBe(false)
    // The RPC score-recompute step still runs independently of whether anything new was flagged.
    expect(supabase.rpc).toHaveBeenCalledWith('apply_crew_score_recompute')
  })

  it('is also a no-op when a matched turnover has no turnover_assignments rows', async () => {
    const supabase = makeSupabase({
      turnovers: { data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: [] }], error: null },
      rpc:       { data: { scored: 0, crewUpdated: 0, capacityUpdated: 0 }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(crewScoreRecompute, { event: {}, step: makeStep(), logger })

    expect(result).toMatchObject({ flagged: 0 })
    expect(supabase.calls.some((c) => c.table === 'assignment_outcomes' && c.method === 'upsert')).toBe(false)
  })

  it('throws when the assignment_outcomes upsert fails, aborting before the RPC step', async () => {
    const supabase = makeSupabase({
      turnovers: {
        data: [{ id: 'to_1', org_id: 'org_1', turnover_assignments: [{ crew_member_id: 'c1' }] }],
        error: null,
      },
      upsert: { error: { message: 'constraint violation' } },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(crewScoreRecompute, { event: {}, step: makeStep(), logger }),
    ).rejects.toThrow(/constraint violation/)

    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('throws when apply_crew_score_recompute RPC errors', async () => {
    const supabase = makeSupabase({
      turnovers: { data: [], error: null },
      rpc:       { data: null, error: { message: 'function apply_crew_score_recompute() does not exist' } },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(crewScoreRecompute, { event: {}, step: makeStep(), logger }),
    ).rejects.toThrow(/apply_crew_score_recompute failed/)
  })
})
