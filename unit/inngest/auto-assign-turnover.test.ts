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
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.neq    = (...a: unknown[]) => record('neq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
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
        { data: [], error: null }, // upcoming workload query
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
        { data: [], error: null },
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
})
