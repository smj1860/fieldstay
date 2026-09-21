import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('server-only', () => ({}))

import { createServiceClient } from '@/lib/supabase/server'
import { getCrewDayContext } from '@/lib/scoring/crew-day-context'

// Same-day cascading-delay context: a crew member's OTHER turnovers earlier
// today, and how far along each actually is. Read-only, decides nothing.

const CHECKOUT = '2026-09-13T16:00:00.000Z'
const EARLIER  = '2026-09-13T10:00:00.000Z'
const CHECKIN  = '2026-09-13T14:00:00.000Z'

/** Every builder method returns the chain; awaiting it (or maybeSingle) resolves. */
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'in', 'neq', 'gte', 'lt', 'limit', 'order', 'not', 'range']
  for (const m of methods) c[m] = vi.fn(() => c)
  c.maybeSingle = vi.fn(() => Promise.resolve(result))
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return c
}

interface Fixture {
  target?:    unknown
  earlier?:   unknown
  instances?: unknown
  items?:     unknown
}

function makeSupabase(f: Fixture) {
  const calls: string[] = []
  // Built once per table, not per .from() call, so a test can inspect the
  // SAME chain object the code under test actually queried through.
  const chains: Record<string, ReturnType<typeof chain>> = {
    turnovers:                 chain(f.target    ?? { data: null, error: null }),
    turnover_assignments:      chain(f.earlier   ?? { data: [], error: null }),
    checklist_instances:       chain(f.instances ?? { data: [], error: null }),
    checklist_instance_items:  chain(f.items     ?? { data: [], error: null }),
  }
  const from = vi.fn((table: string) => {
    calls.push(table)
    if (!(table in chains)) throw new Error(`Unexpected table: ${table}`)
    return chains[table]
  })
  return { from, callsByTable: () => calls, chains }
}

const targetWithCrew = (crew: { id: string; name: string }[]) => ({
  data: {
    checkout_datetime: CHECKOUT,
    turnover_assignments: crew.map((c) => ({ crew_member_id: c.id, crew_members: { id: c.id, name: c.name } })),
  },
  error: null,
})

const earlierRow = (crewId: string, turnoverId: string, checkin = CHECKIN) => ({
  crew_member_id: crewId,
  turnovers: { id: turnoverId, property_id: 'prop_1', checkout_datetime: EARLIER, checkin_datetime: checkin },
})

const item = (isCompleted: boolean, completedAt: string | null = null) => ({
  instance_id: 'inst_1',
  is_completed: isCompleted,
  completed_at: completedAt,
})

const HALF_DONE = [item(true, '2026-09-13T10:30:00.000Z'), item(false)]
const ALL_DONE  = [item(true, '2026-09-13T10:30:00.000Z'), item(true, '2026-09-13T11:00:00.000Z')]

/**
 * Dana, with exactly one OTHER turnover earlier today, one checklist instance
 * on it, and whatever item rows the caller wants against that instance.
 * `instance: false` is the no-checklist-at-all case.
 */
const soloDay = (items: unknown[], opts: { instance?: boolean } = {}): Fixture => ({
  target:  targetWithCrew([{ id: 'crew_1', name: 'Dana' }]),
  earlier: { data: [earlierRow('crew_1', 'tvr_earlier')], error: null },
  instances: {
    data: opts.instance === false ? [] : [{ id: 'inst_1', turnover_id: 'tvr_earlier' }],
    error: null,
  },
  items: { data: items, error: null },
})

describe('getCrewDayContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Before CHECKIN, so nothing is late unless a test moves the clock.
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('returns only the crew member\'s OTHER earlier turnovers today', async () => {
    const supabase = makeSupabase(soloDay(HALF_DONE))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await getCrewDayContext('tvr_flagged', 'org_1')

    expect(result).toEqual([{
      crewMemberId:   'crew_1',
      crewMemberName: 'Dana',
      earlierTurnoversToday: [{
        turnoverId:       'tvr_earlier',
        propertyId:       'prop_1',
        checkoutDatetime: EARLIER,
        checkinDatetime:  CHECKIN,
        hasStarted:       true,
        completionRatio:  0.5,
        isRunningLate:    false,
      }],
    }])
  })

  it('returns an empty array for a crew member with no other turnovers today', async () => {
    const supabase = makeSupabase({
      target:  targetWithCrew([{ id: 'crew_1', name: 'Dana' }]),
      earlier: { data: [], error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await getCrewDayContext('tvr_flagged', 'org_1')
    expect(result).toEqual([{ crewMemberId: 'crew_1', crewMemberName: 'Dana', earlierTurnoversToday: [] }])
  })

  it('degrades gracefully when the checklist instance has zero items', async () => {
    // Not a throw, and not a fabricated 0 — no items means no progress SIGNAL,
    // which is a different claim from "nothing has been done".
    const supabase = makeSupabase(soloDay([]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const [ctx] = await getCrewDayContext('tvr_flagged', 'org_1')
    expect(ctx!.earlierTurnoversToday[0]).toMatchObject({ hasStarted: false, completionRatio: null })
  })

  it('degrades gracefully when there is no checklist instance at all', async () => {
    const supabase = makeSupabase(soloDay([], { instance: false }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const [ctx] = await getCrewDayContext('tvr_flagged', 'org_1')
    expect(ctx!.earlierTurnoversToday[0]).toMatchObject({ hasStarted: false, completionRatio: null })
  })

  it('flags a turnover past its own checkin with an incomplete checklist', async () => {
    vi.setSystemTime(new Date('2026-09-13T15:00:00.000Z')) // past CHECKIN
    const supabase = makeSupabase(soloDay(HALF_DONE))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const [ctx] = await getCrewDayContext('tvr_flagged', 'org_1')
    expect(ctx!.earlierTurnoversToday[0]!.isRunningLate).toBe(true)
  })

  it('does NOT flag a COMPLETE turnover even when past its checkin', async () => {
    vi.setSystemTime(new Date('2026-09-13T15:00:00.000Z'))
    const supabase = makeSupabase(soloDay(ALL_DONE))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const [ctx] = await getCrewDayContext('tvr_flagged', 'org_1')
    expect(ctx!.earlierTurnoversToday[0]).toMatchObject({ completionRatio: 1, isRunningLate: false })
  })

  it('reads each table ONCE regardless of how many crew or turnovers there are', async () => {
    // The shape the spec sketched looped per crew member and then per
    // turnover, issuing a checklist_instances read and a
    // checklist_instance_items read for every earlier job — the N+1 that
    // unit/guardrails/n-plus-one-loops.test.ts exists to catch. Two crew, two
    // earlier turnovers each: four per-row reads under that shape, one under
    // this one.
    const supabase = makeSupabase({
      target:  targetWithCrew([{ id: 'crew_1', name: 'Dana' }, { id: 'crew_2', name: 'Sam' }]),
      earlier: { data: [
        earlierRow('crew_1', 'tvr_a'), earlierRow('crew_1', 'tvr_b'),
        earlierRow('crew_2', 'tvr_c'), earlierRow('crew_2', 'tvr_d'),
      ], error: null },
      instances: { data: [
        { id: 'inst_a', turnover_id: 'tvr_a' }, { id: 'inst_b', turnover_id: 'tvr_b' },
        { id: 'inst_c', turnover_id: 'tvr_c' }, { id: 'inst_d', turnover_id: 'tvr_d' },
      ], error: null },
      items: { data: [{ instance_id: 'inst_a', is_completed: true, completed_at: EARLIER }], error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await getCrewDayContext('tvr_flagged', 'org_1')

    const calls = supabase.callsByTable()
    expect(calls.filter((t) => t === 'checklist_instances')).toHaveLength(1)
    expect(calls.filter((t) => t === 'checklist_instance_items')).toHaveLength(1)
    expect(calls.filter((t) => t === 'turnover_assignments')).toHaveLength(1)

    expect(result).toHaveLength(2)
    expect(result[0]!.earlierTurnoversToday).toHaveLength(2)
    expect(result[1]!.earlierTurnoversToday).toHaveLength(2)
  })

  it('paginates the checklist-items read via .range(), not a bare .limit()', async () => {
    // MAX_CHECKLIST_ITEMS (4000) is deliberately above PostgREST's own
    // max_rows (1000) — a busy crew member's several same-day turnovers can
    // genuinely carry that many items — so a bare .limit(4000) would silently
    // truncate at 1000 with no signal. Only .range()-based pagination
    // actually reaches the real ceiling.
    const supabase = makeSupabase(soloDay(HALF_DONE))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await getCrewDayContext('tvr_flagged', 'org_1')

    const itemsChain = supabase.chains.checklist_instance_items
    expect(itemsChain.range).toHaveBeenCalled()
    expect(itemsChain.limit).not.toHaveBeenCalled()
  })

  it('returns [] when the flagged turnover does not exist', async () => {
    const supabase = makeSupabase({ target: { data: null, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    expect(await getCrewDayContext('nope', 'org_1')).toEqual([])
  })

  it('handles a to-one crew_members embed arriving as an ARRAY', async () => {
    // PostgREST has returned both shapes for the same select across versions.
    const supabase = makeSupabase({
      target: {
        data: {
          checkout_datetime: CHECKOUT,
          turnover_assignments: [{ crew_member_id: 'crew_1', crew_members: [{ id: 'crew_1', name: 'Dana' }] }],
        },
        error: null,
      },
      earlier: { data: [], error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const [ctx] = await getCrewDayContext('tvr_flagged', 'org_1')
    expect(ctx!.crewMemberName).toBe('Dana')
  })
})
