import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { autoAssignTurnover } from '@/lib/inngest/functions/auto-assign-turnover'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Every step actually runs (matching on-failure.test.ts's makeStep()) — this
// function's only side effects are Supabase reads/writes plus a dynamically
// imported logAuditEvent call, both of which are mocked below, so there's no
// need to allowlist individual steps.
function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

interface QueuedByTable {
  [table: string]: unknown[]
}

// Queue-based `.from(table)` mock — see unit/owner-portal/load-owner-portal-data.test.ts
// for the reference pattern. Each `.from(table)` call consumes the next
// queued response for that table (in call order), regardless of whether it's
// resolved via `.single()`, `.maybeSingle()`, or a bare `await`.
function makeSupabase(queued: QueuedByTable) {
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
    // These reads paginate via fetchAllRows(), which drains .order().range().
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.range  = (...a: unknown[]) => record('range', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.neq    = (...a: unknown[]) => record('neq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.gte    = (...a: unknown[]) => record('gte', a)
    chain.lte    = (...a: unknown[]) => record('lte', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const ORG_ID       = 'org_1'
const PROPERTY_ID  = 'prop_1'
const TURNOVER_ID  = 'to_1'
const CHECKOUT_ISO = '2026-07-25T11:00:00.000Z'

function baseEvent() {
  return {
    data: {
      turnover_id:       TURNOVER_ID,
      property_id:       PROPERTY_ID,
      org_id:            ORG_ID,
      checkout_datetime: CHECKOUT_ISO,
      checkin_datetime:  '2026-07-25T16:00:00.000Z',
      window_minutes:    300,
    },
  }
}

type CrewRow = {
  id: string
  name?: string
  home_lat?: number | null
  home_lng?: number | null
  reliability_score?: number
  capacity_score?: number
  auto_assign_eligible?: boolean
  max_turnovers_per_day?: number | null
}

/** One upcoming assignment for `crewId`, on `when` (defaults to this turnover's day). */
function held(crewId: string, when: string = CHECKOUT_ISO) {
  return { crew_member_id: crewId, turnovers: { checkout_datetime: when } }
}

/**
 * The scaffolding every test here shares, so each one shows only what it is
 * actually about.
 *
 * The org/turnover/property rows are identical in all of them and carry no
 * meaning for any individual case; spelling them out per test buried the one
 * or two lines that did matter, and made the file 83% duplicated lines once
 * the capacity cases landed.
 *
 * `turnover_assignments` is a QUEUE and its order is load-bearing: the
 * familiarity read (one joined query) comes first, the workload read second,
 * and the autopilot insert third. Expressed as named options rather than a
 * positional array so a test cannot silently feed workload rows to the
 * familiarity read.
 */
function fixture(over: {
  mode?:         'autopilot' | 'suggest' | 'disabled'
  crew:          CrewRow[]
  /** Crew who marked the checkout date as time off. */
  unavailable?:  string[]
  /** Upcoming assignments, for both the 14-day and per-day workload counts. */
  workload?:     ReturnType<typeof held>[]
  /** True when the run is expected to reach the assignment insert. */
  assigns?:      boolean
}) {
  const assignmentQueue: { data?: unknown; error?: unknown }[] = [
    { data: [], error: null },                      // familiarity (joined)
    { data: over.workload ?? [], error: null },     // upcoming workload
  ]
  if (over.assigns) assignmentQueue.push({ error: null })  // autopilot insert

  return makeSupabase({
    organizations: [{ data: { auto_assign_mode: over.mode ?? 'autopilot' }, error: null }],
    turnovers:     [{ data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null }],
    properties:    [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
    crew_members:  [{
      data: over.crew.map((c) => ({
        name: c.id, home_lat: 30.0, home_lng: -90.0,
        reliability_score: 1.0, capacity_score: 1.0, auto_assign_eligible: true,
        ...c,
      })),
      error: null,
    }],
    crew_availability:   [{ data: (over.unavailable ?? []).map((id) => ({ crew_member_id: id })), error: null }],
    turnover_assignments: assignmentQueue,
    assignment_outcomes:  [{ error: null }],
  })
}

describe('autoAssignTurnover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when auto_assign_mode is disabled', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'disabled' }, error: null }],
      turnovers:     [{ data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null }],
      properties:    [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members:  [{ data: [{ id: 'c1', name: 'Crew One', home_lat: 30.0, home_lng: -90.0, reliability_score: 1, capacity_score: 1 }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ skipped: true, reason: 'disabled or no candidates' })
    // Mode gate trips before any availability/familiarity/workload lookups run.
    expect(supabase.calls.some((c) => c.table === 'crew_availability')).toBe(false)
  })

  it('SAFETY: excludes a crew member marked unavailable for the checkout date, even when they would otherwise score highest', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'autopilot' }, error: null }],
      turnovers: [
        { data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null }, // main fetch
        { data: [], error: null }, // propertyTurnovers (no history)
        { error: null },           // status update in act-on-mode
      ],
      properties: [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{
        data: [
          // c1 is a perfect proximity/reliability/capacity match but unavailable —
          // must never be picked despite dominating every score component.
          { id: 'c1', name: 'Unavailable Nearby Crew', home_lat: 30.0, home_lng: -90.0, reliability_score: 1.0, capacity_score: 1.0 },
          { id: 'c2', name: 'Available Farther Crew',  home_lat: 31.0, home_lng: -91.0, reliability_score: 0.5, capacity_score: 0.5 },
        ],
        error: null,
      }],
      crew_availability: [{ data: [{ crew_member_id: 'c1' }], error: null }],
      turnover_assignments: [
        // Familiarity is now ONE joined read (turnovers!inner) instead of a
        // turnovers id-list scan feeding an .in() — so it consumes a
        // turnover_assignments slot that used to belong to the turnovers table.
        { data: [], error: null }, // familiarity (joined)
        { data: [], error: null }, // upcoming workload
        { error: null },           // insert (autopilot assignment)
      ],
      assignment_outcomes: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ action: 'autopilot_assigned', top_crew: 'Available Farther Crew' })
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ crew_member_id: 'c2' }) })
    )

    const insertCall = supabase.calls.find((c) => c.table === 'turnover_assignments' && c.method === 'insert')
    expect(insertCall?.args[0]).toMatchObject({ crew_member_id: 'c2' })
  })

  it('never picks a crew member the PM excluded from auto-assignment', async () => {
    // crew_members.auto_assign_eligible (20260827034958). c1 dominates every
    // score component, exactly like the time-off test above, so a result of c2
    // can only come from the exclusion being honoured.
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'autopilot' }, error: null }],
      turnovers: [
        { data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null },
        { data: [], error: null },
        { error: null },
      ],
      properties: [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{
        data: [
          { id: 'c1', name: 'Excluded Nearby Crew', home_lat: 30.0, home_lng: -90.0, reliability_score: 1.0, capacity_score: 1.0, auto_assign_eligible: false },
          { id: 'c2', name: 'Eligible Farther Crew', home_lat: 31.0, home_lng: -91.0, reliability_score: 0.5, capacity_score: 0.5, auto_assign_eligible: true },
        ],
        error: null,
      }],
      crew_availability: [{ data: [], error: null }],
      turnover_assignments: [
        { data: [], error: null },
        { data: [], error: null },
        { error: null },
      ],
      assignment_outcomes: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ action: 'autopilot_assigned', top_crew: 'Eligible Farther Crew' })
    const insertCall = supabase.calls.find((c) => c.table === 'turnover_assignments' && c.method === 'insert')
    expect(insertCall?.args[0]).toMatchObject({ crew_member_id: 'c2' })
  })

  it('treats a MISSING eligibility value as eligible, not as excluded', async () => {
    // The column is NOT NULL, so this cannot happen from a real row — which is
    // the point. If the field ever vanishes from the select string, the failure
    // must be "the opt-out stops working", not "every org stops getting
    // assignments". Truthiness would give the second.
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'autopilot' }, error: null }],
      turnovers: [
        { data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null },
        { data: [], error: null },
        { error: null },
      ],
      properties: [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{
        data: [{ id: 'c1', name: 'No Flag Crew', home_lat: 30.0, home_lng: -90.0, reliability_score: 1.0, capacity_score: 1.0 }],
        error: null,
      }],
      crew_availability: [{ data: [], error: null }],
      turnover_assignments: [
        { data: [], error: null },
        { data: [], error: null },
        { error: null },
      ],
      assignment_outcomes: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })
    expect(result).toEqual({ action: 'autopilot_assigned', top_crew: 'No Flag Crew' })
  })

  it('alerts the PM, with a reason, when every active crew member is excluded', async () => {
    // Previously this path returned null and said NOTHING — the turnover simply
    // sat unassigned. An org that has crew and has excluded all of them is
    // exactly the case a PM can fix and cannot otherwise see.
    const step = makeStep()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(fixture({
      crew: [{ id: 'c1', name: 'Only Crew', auto_assign_eligible: false }],
    }))

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step })

    expect(result).toEqual({ gap: true })
    expect(step.sendEvent).toHaveBeenCalledWith('notify-assignment-gap', expect.objectContaining({
      name: 'crew/assignment-gap',
      data: expect.objectContaining({ crew_found: 0, reason: 'none_eligible' }),
    }))
  })

  it('alerts with all_unavailable when the eligible pool is emptied by time off', async () => {
    // The same silence existed here: an org whose whole eligible roster booked
    // the day off got no assignment and no alert. Distinguished from the case
    // above so the email can name the right lever.
    const step = makeStep()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(fixture({
      crew:        [{ id: 'c1', name: 'Only Crew' }],
      unavailable: ['c1'],
    }))

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step })

    expect(result).toEqual({ gap: true })
    expect(step.sendEvent).toHaveBeenCalledWith('notify-assignment-gap', expect.objectContaining({
      data: expect.objectContaining({ reason: 'all_unavailable' }),
    }))
  })

  it('asks for a day re-plan after an autopilot assignment', async () => {
    // Phase E. An autopilot assignment changes the day as much as a PM's own
    // does, and nobody is in the loop to notice the overnight plan went stale.
    const step = makeStep()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(fixture({
      crew:    [{ id: 'c1', name: 'Planner Crew' }],
      assigns: true,
    }))

    await invokeHandler(autoAssignTurnover, { event: baseEvent(), step })

    expect(step.sendEvent).toHaveBeenCalledWith('replan-day', expect.objectContaining({
      name: 'org/day_plan.requested',
      // The CENTRAL operating day for this checkout, not a UTC slice: from
      // about 7pm CT those name different dates and the cron writes the former.
      data: expect.objectContaining({ org_id: ORG_ID, plan_date: '2026-07-25' }),
    }))
  })

  it('asks for no re-plan when nothing was assigned', async () => {
    // A suggestion changed no assignment, so the existing plan still holds.
    // Re-planning anyway would be a wasted org-wide pass on every suggestion.
    const step = makeStep()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(fixture({
      mode: 'suggest',
      crew: [{ id: 'c1', name: 'Suggested Crew' }],
    }))

    await invokeHandler(autoAssignTurnover, { event: baseEvent(), step })

    const replans = step.sendEvent.mock.calls.filter((c: unknown[]) => c[0] === 'replan-day')
    expect(replans).toHaveLength(0)
  })

  it('alerts with all_at_capacity when every eligible crew member has hit their daily limit', async () => {
    // Phase D. The third way a filter can empty a pool that has people in it,
    // and the only one the PM created themselves — so it needs its own reason
    // for the same purpose as the two above: naming the lever they can pull.
    const step = makeStep()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(fixture({
      crew:     [{ id: 'c1', name: 'Fully Booked', max_turnovers_per_day: 2 }],
      workload: [held('c1'), held('c1')],   // both on this turnover's own date
    }))

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step })

    expect(result).toEqual({ gap: true })
    expect(step.sendEvent).toHaveBeenCalledWith('notify-assignment-gap', expect.objectContaining({
      data: expect.objectContaining({ reason: 'all_at_capacity' }),
    }))
  })

  it('counts only the turnover\'s OWN date against the cap, not the whole window', async () => {
    // The distinction the whole phase turns on. Three assignments inside the
    // 14-day window but none on this date leaves the crew member free, and a
    // cap read off the fortnight count would wrongly exclude them.
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(fixture({
      crew:     [{ id: 'c1', name: 'Busy Fortnight', max_turnovers_per_day: 2 }],
      workload: [
        held('c1', '2026-07-26T11:00:00.000Z'),
        held('c1', '2026-07-27T11:00:00.000Z'),
        held('c1', '2026-07-28T11:00:00.000Z'),
      ],
      assigns: true,
    }))

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ action: 'autopilot_assigned', top_crew: 'Busy Fortnight' })
  })

  it('leaves a crew member with no cap set assignable at any volume', async () => {
    // null = no limit is what every existing row carries, so this is the
    // no-change-for-existing-orgs guarantee the migration promises.
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(fixture({
      crew:     [{ id: 'c1', name: 'Uncapped', max_turnovers_per_day: null }],
      workload: Array.from({ length: 9 }, () => held('c1')),
      assigns:  true,
    }))

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ action: 'autopilot_assigned', top_crew: 'Uncapped' })
  })

  it('sends NO reason when the org simply has no active crew — nothing to act on', async () => {
    // The control for the two above. An empty roster is not a filter problem
    // and needs no alert; without this, "always send a gap" would pass them
    // both while spamming orgs that have not hired anyone yet.
    const step = makeStep()
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'autopilot' }, error: null }],
      turnovers: [{ data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null }],
      properties: [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step })

    expect(result).toEqual({ skipped: true, reason: 'disabled or no candidates' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('idempotency: a duplicate autopilot assignment (23505) is reported as already_assigned without a second audit log entry', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'autopilot' }, error: null }],
      turnovers: [
        { data: { id: TURNOVER_ID, status: 'assigned', is_same_day_turnover: false }, error: null },
        { data: [], error: null },
      ],
      properties:   [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{ data: [{ id: 'c1', name: 'Crew One', home_lat: 30.0, home_lng: -90.0, reliability_score: 1, capacity_score: 1 }], error: null }],
      crew_availability: [{ data: [], error: null }],
      turnover_assignments: [
        { data: [], error: null }, // familiarity (joined)
        { data: [], error: null }, // upcoming workload
        { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      ],
      assignment_outcomes: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ action: 'already_assigned', top_crew: 'Crew One' })
    expect(logAuditEvent).not.toHaveBeenCalled()
    // No second turnovers.update — the code returns immediately on 23505,
    // before reaching the status-update call in that branch.
    const turnoverUpdates = supabase.calls.filter((c) => c.table === 'turnovers' && c.method === 'update')
    expect(turnoverUpdates).toHaveLength(0)
    // The outcome row is still recorded, with was_accepted true for the
    // already-assigned case (see wasAutopilotAssigned in the source).
    const outcomeUpsert = supabase.calls.find((c) => c.table === 'assignment_outcomes' && c.method === 'upsert')
    expect(outcomeUpsert?.args[0]).toMatchObject({ was_accepted: true })
  })

  it('"suggest" mode writes a suggestion but never creates a turnover_assignments row', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'suggest' }, error: null }],
      turnovers: [
        { data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null },
        { data: [], error: null },
        { error: null }, // suggestion-write update
      ],
      properties:   [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{ data: [{ id: 'c1', name: 'Crew One', home_lat: 30.0, home_lng: -90.0, reliability_score: 1, capacity_score: 1 }], error: null }],
      crew_availability: [{ data: [], error: null }],
      turnover_assignments: [{ data: [], error: null }],
      assignment_outcomes: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ action: 'suggested', top_crew: 'Crew One' })
    expect(supabase.calls.some((c) => c.table === 'turnover_assignments' && c.method === 'insert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()

    const suggestionWrite = supabase.calls.find((c) => c.table === 'turnovers' && c.method === 'update')
    expect(suggestionWrite?.args[0]).toMatchObject({ suggested_crew_ids: ['c1'], suggestion_status: 'pending' })
  })
  // ── P3-3 / P3-4 / P3-5: what this function is allowed to cost, and to race ──

  it('serialises per turnover, so two concurrent runs cannot assign two crew to one job', () => {
    // The global `limit: 10` does NOT stop two runs for the SAME turnover
    // overlapping (a duplicate turnover/created, or a retry racing the
    // original). The (turnover_id, crew_member_id) unique index only catches
    // them picking the SAME crew member — scores shift with workload, so two
    // runs can pick DIFFERENT top candidates and both inserts succeed.
    //
    // Asserted on the function's config rather than by simulating a race,
    // because the guarantee IS the config: Inngest enforces it, and there is
    // nothing in this process to observe.
    const concurrency = (autoAssignTurnover as unknown as {
      opts: { concurrency: Array<{ limit: number; key?: string }> }
    }).opts.concurrency

    expect(Array.isArray(concurrency)).toBe(true)
    expect(concurrency).toContainEqual({ limit: 1, key: 'event.data.turnover_id' })
    // …without giving up the global cap that keeps a bulk fan-out from
    // exhausting the connection pool.
    expect(concurrency).toContainEqual({ limit: 10 })
  })

  it('pages the crew roster instead of silently scoring only the first 1,000', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'suggest' }, error: null }],
      turnovers: [
        { data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null },
        { error: null },
      ],
      properties:   [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{ data: [{ id: 'c1', name: 'Crew One', home_lat: 30.0, home_lng: -90.0, reliability_score: 1, capacity_score: 1 }], error: null }],
      crew_availability: [{ data: [], error: null }],
      turnover_assignments: [{ data: [], error: null }, { data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    const crewCalls = supabase.calls.filter((c) => c.table === 'crew_members')
    expect(crewCalls.some((c) => c.method === 'range')).toBe(true)
  })

  it('resolves familiarity with a JOIN, never an id list in the query string', async () => {
    // The old shape read every past turnover id for the property, then passed
    // the whole set to `.in('turnover_id', …)`. Both reads paginated, so
    // neither truncated — but `.in()` puts every id in the QUERY STRING, on
    // every page, so a property with a few thousand turnovers builds a request
    // line a gateway rejects. Pagination does not help; it repeats it.
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'suggest' }, error: null }],
      turnovers: [
        { data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null },
        { error: null },
      ],
      properties:   [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{ data: [{ id: 'c1', name: 'Crew One', home_lat: 30.0, home_lng: -90.0, reliability_score: 1, capacity_score: 1 }], error: null }],
      crew_availability: [{ data: [], error: null }],
      turnover_assignments: [{ data: [], error: null }, { data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    // The property is filtered through the embed, server-side.
    const selects = supabase.calls.filter((c) => c.table === 'turnover_assignments' && c.method === 'select')
    expect(selects.some((c) => String(c.args[0]).includes('turnovers!inner'))).toBe(true)

    const eqs = supabase.calls.filter((c) => c.table === 'turnover_assignments' && c.method === 'eq')
    expect(eqs).toContainEqual(expect.objectContaining({ args: ['turnovers.property_id', PROPERTY_ID] }))

    // And the id-list scan that fed it is gone: no read of `turnovers` that
    // pages a bare id column.
    const turnoverIdScan = supabase.calls.filter(
      (c) => c.table === 'turnovers' && c.method === 'select' && String(c.args[0]).trim() === 'id',
    )
    expect(turnoverIdScan).toEqual([])
  })

  it('windows familiarity rather than scanning the property\'s whole lifetime', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { auto_assign_mode: 'suggest' }, error: null }],
      turnovers: [
        { data: { id: TURNOVER_ID, status: 'pending_assignment', is_same_day_turnover: false }, error: null },
        { error: null },
      ],
      properties:   [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0, bedrooms: 2 }, error: null }],
      crew_members: [{ data: [{ id: 'c1', name: 'Crew One', home_lat: 30.0, home_lng: -90.0, reliability_score: 1, capacity_score: 1 }], error: null }],
      crew_availability: [{ data: [], error: null }],
      turnover_assignments: [{ data: [], error: null }, { data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(autoAssignTurnover, { event: baseEvent(), step: makeStep() })

    const gte = supabase.calls.find(
      (c) => c.table === 'turnover_assignments' && c.method === 'gte' && c.args[0] === 'turnovers.checkout_datetime',
    )
    expect(gte, 'familiarity must be bounded to a rolling window').toBeDefined()

    // ~90 days back, allowing a second of clock drift during the test.
    const cutoff = new Date(String(gte?.args[1])).getTime()
    const expected = Date.now() - 90 * 86_400_000
    expect(Math.abs(cutoff - expected)).toBeLessThan(60_000)
  })
})
