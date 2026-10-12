import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('server-only', () => ({}))

import { createServiceClient } from '@/lib/supabase/server'
import { loadOrgDayCrewJobs } from '@/lib/scoring/crew-day-context'
import type { Baselines } from '@/lib/planning/baselines'

// One org's one operating day, read for lib/scoring/cascade.ts to rank.
// Read-only, decides nothing. These tests replaced the per-turnover
// getCrewDayContext()'s, which the cascade-alert cron superseded — calling a
// per-turnover function once per turnover, 48 times a day, is the N+1 the
// 'reads each table ONCE' case below pins down.

const DAY_START = '2026-09-13T05:00:00.000Z'
const DAY_END   = '2026-09-14T05:00:00.000Z'
const CHECKOUT  = '2026-09-13T15:00:00.000Z'
const CHECKIN   = '2026-09-13T21:00:00.000Z'

const BASELINES: Baselines = { byCrew: new Map([['crew_1', 50]]), median: 40 }

/** Every builder method returns the chain; awaiting it resolves. */
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'in', 'neq', 'gte', 'lt', 'limit', 'order', 'not', 'range']
  for (const m of methods) c[m] = vi.fn(() => c)
  c.maybeSingle = vi.fn(() => Promise.resolve(result))
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return c
}

interface Fixture {
  assignments?: unknown
  instances?:   unknown
  items?:       unknown
}

function makeSupabase(f: Fixture) {
  const calls: string[] = []
  // Built once per table, not per .from() call, so a test can inspect the
  // SAME chain object the code under test actually queried through.
  const chains: Record<string, ReturnType<typeof chain>> = {
    turnover_assignments:     chain(f.assignments ?? { data: [], error: null }),
    checklist_instances:      chain(f.instances   ?? { data: [], error: null }),
    checklist_instance_items: chain(f.items       ?? { data: [], error: null }),
  }
  const from = vi.fn((table: string) => {
    calls.push(table)
    if (!(table in chains)) throw new Error(`Unexpected table: ${table}`)
    return chains[table]
  })
  return { from, callsByTable: () => calls, chains }
}

const PROPERTY = { name: 'Juniper Cottage', lat: 32.5, lng: -85.9, bedrooms: 3 }

const assignmentRow = (over: Record<string, unknown> = {}) => ({
  crew_member_id:    'crew_1',
  turnover_id:       'tvr_a',
  planned_start_at:  null,
  plan_published_at: null,
  crew_members:      { name: 'Dana' },
  turnovers: {
    checkout_datetime: CHECKOUT,
    checkin_datetime:  CHECKIN,
    properties:        PROPERTY,
  },
  ...over,
})

const item = (isCompleted: boolean, completedAt: string | null = null) => ({
  instance_id: 'inst_a', is_completed: isCompleted, completed_at: completedAt,
})

const HALF_DONE = [item(true, '2026-09-13T16:30:00.000Z'), item(false)]
const ALL_DONE  = [item(true, '2026-09-13T16:30:00.000Z'), item(true, '2026-09-13T17:00:00.000Z')]

/** One crew member, one turnover, one instance, whatever items the caller wants. */
const soloDay = (items: unknown[], opts: { instance?: boolean } = {}): Fixture => ({
  assignments: { data: [assignmentRow()], error: null },
  instances: {
    data: opts.instance === false ? [] : [{ id: 'inst_a', turnover_id: 'tvr_a' }],
    error: null,
  },
  items: { data: items, error: null },
})

const load = () => loadOrgDayCrewJobs('org_1', DAY_START, DAY_END, BASELINES)

function mock(f: Fixture) {
  const supabase = makeSupabase(f)
  ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
  return supabase
}

describe('loadOrgDayCrewJobs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns one rankable job per assignment, grouped by crew member', async () => {
    mock(soloDay(HALF_DONE))

    expect(await load()).toEqual([{
      crewMemberId:   'crew_1',
      crewMemberName: 'Dana',
      jobs: [{
        turnoverId:      'tvr_a',
        propertyName:    'Juniper Cottage',
        startAt:         CHECKOUT,
        checkinAt:       CHECKIN,
        lat:             32.5,
        lng:             -85.9,
        durationMinutes: 150,   // 3 bedrooms x this crew member's own 50 min
        completionRatio: 0.5,
      }],
    }])
  })

  it('returns nothing when the org has no in-flight assignments today', async () => {
    mock({ assignments: { data: [], error: null } })
    expect(await load()).toEqual([])
  })

  // null, not 0: no items means no progress SIGNAL, which is a different claim
  // from "nothing has been done". cascade.ts reads the null pessimistically
  // and labels it; this read does not guess on its behalf.
  it('reports a null completion ratio when the checklist has zero items', async () => {
    mock(soloDay([]))
    const [day] = await load()
    expect(day!.jobs[0]!.completionRatio).toBeNull()
  })

  it('reports a null completion ratio when there is no checklist instance at all', async () => {
    mock(soloDay([], { instance: false }))
    const [day] = await load()
    expect(day!.jobs[0]!.completionRatio).toBeNull()
  })

  it('reports a ratio of 1 for a finished checklist', async () => {
    mock(soloDay(ALL_DONE))
    const [day] = await load()
    expect(day!.jobs[0]!.completionRatio).toBe(1)
  })

  it('falls back to the org median for a crew member with no speed baseline', async () => {
    mock({
      assignments: { data: [assignmentRow({ crew_member_id: 'crew_new' })], error: null },
      instances:   { data: [], error: null },
    })
    const [day] = await load()
    expect(day!.jobs[0]!.durationMinutes).toBe(120)   // 3 bedrooms x the median's 40
  })

  describe('which start time it reports', () => {
    // An unpublished planned time is a draft nobody agreed to, so the alert
    // has to measure against what the crew member is actually looking at.
    it('uses checkout when a plan exists but is unpublished', async () => {
      mock({ assignments: { data: [assignmentRow({
        planned_start_at: '2026-09-13T15:40:00.000Z', plan_published_at: null,
      })], error: null } })
      const [day] = await load()
      expect(day!.jobs[0]!.startAt).toBe(CHECKOUT)
    })

    it('uses the planned start once the day is published', async () => {
      mock({ assignments: { data: [assignmentRow({
        planned_start_at:  '2026-09-13T15:40:00.000Z',
        plan_published_at: '2026-09-13T12:00:00.000Z',
      })], error: null } })
      const [day] = await load()
      expect(day!.jobs[0]!.startAt).toBe('2026-09-13T15:40:00.000Z')
    })

    it('uses checkout when published with no planned time written', async () => {
      mock({ assignments: { data: [assignmentRow({
        planned_start_at: null, plan_published_at: '2026-09-13T12:00:00.000Z',
      })], error: null } })
      const [day] = await load()
      expect(day!.jobs[0]!.startAt).toBe(CHECKOUT)
    })
  })

  it('reads each table ONCE regardless of how many crew or turnovers there are', async () => {
    // The obvious shape loops per crew member and then per turnover, issuing a
    // checklist_instances read and a checklist_instance_items read for every
    // job — the N+1 that unit/guardrails/n-plus-one-loops.test.ts exists to
    // catch. Two crew, two turnovers each: four per-row reads under that
    // shape, one under this one.
    const supabase = mock({
      assignments: { data: [
        assignmentRow({ crew_member_id: 'crew_1', turnover_id: 'tvr_a' }),
        assignmentRow({ crew_member_id: 'crew_1', turnover_id: 'tvr_b' }),
        assignmentRow({ crew_member_id: 'crew_2', turnover_id: 'tvr_c', crew_members: { name: 'Sam' } }),
        assignmentRow({ crew_member_id: 'crew_2', turnover_id: 'tvr_d', crew_members: { name: 'Sam' } }),
      ], error: null },
      instances: { data: [
        { id: 'inst_a', turnover_id: 'tvr_a' }, { id: 'inst_b', turnover_id: 'tvr_b' },
        { id: 'inst_c', turnover_id: 'tvr_c' }, { id: 'inst_d', turnover_id: 'tvr_d' },
      ], error: null },
      items: { data: [item(true, CHECKOUT)], error: null },
    })

    const result = await load()

    const calls = supabase.callsByTable()
    expect(calls.filter((t) => t === 'turnover_assignments')).toHaveLength(1)
    expect(calls.filter((t) => t === 'checklist_instances')).toHaveLength(1)
    expect(calls.filter((t) => t === 'checklist_instance_items')).toHaveLength(1)

    expect(result).toHaveLength(2)
    expect(result[0]!.jobs).toHaveLength(2)
    expect(result[1]!.jobs).toHaveLength(2)
    expect(result[1]!.crewMemberName).toBe('Sam')
  })

  it('paginates both row-heavy reads via .range(), not a bare .limit()', async () => {
    // MAX_CHECKLIST_ITEMS (4000) is deliberately above PostgREST's own
    // max_rows (1000), so a bare .limit(4000) would silently truncate at 1000
    // with no signal. Only .range()-based pagination reaches the real ceiling.
    const supabase = mock(soloDay(HALF_DONE))
    await load()

    for (const table of ['turnover_assignments', 'checklist_instance_items']) {
      expect(supabase.chains[table]!.range).toHaveBeenCalled()
      expect(supabase.chains[table]!.limit).not.toHaveBeenCalled()
    }
  })

  it('handles to-one embeds arriving as ARRAYS', async () => {
    // PostgREST has returned both shapes for the same select across versions.
    mock({ assignments: { data: [assignmentRow({
      crew_members: [{ name: 'Dana' }],
      turnovers: {
        checkout_datetime: CHECKOUT, checkin_datetime: CHECKIN, properties: [PROPERTY],
      },
    })], error: null } })

    const [day] = await load()
    expect(day!.crewMemberName).toBe('Dana')
    expect(day!.jobs[0]!.propertyName).toBe('Juniper Cottage')
  })

  it('skips an assignment whose turnover embed is absent', async () => {
    mock({ assignments: { data: [assignmentRow({ turnovers: null })], error: null } })
    expect(await load()).toEqual([])
  })
})
