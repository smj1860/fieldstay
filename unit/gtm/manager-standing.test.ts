import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})), send: vi.fn() } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const state = vi.hoisted(() => ({ client: null as unknown, apply: vi.fn(), facts: vi.fn() }))
vi.mock('@/lib/gtm/manager/facts', () => ({ loadInstructionFacts: state.facts }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.client }))
vi.mock('@/lib/gtm/manager/apply', async (orig) => ({
  ...(await orig<typeof import('@/lib/gtm/manager/apply')>()),
  applyAction: state.apply,
}))

import { planStanding, runStanding, type StandingPlan } from '@/lib/inngest/functions/gtm-manager-instruction'
import { fakeSupabase, type Scripted } from './fake-supabase'

// ============================================================================
// The standing runner is the part that acts with nobody watching, so the
// questions that matter are the refusals: nothing runs unless a person granted
// it, the manager is on, it is due, and the inbox is not already full.
// ============================================================================

const on = (team: string) => ({ team, enabled: true, autonomy: 'propose_only', daily_task_cap: 10, daily_cost_cap_cents: 100 })
const settingsOn = { data: [on('global'), on('manager')], error: null }

function human(day: string, status = 'applied') {
  return { source: 'human', status, action_kinds: ['run_funnel_report'], decided_at: `${day}T15:00:00Z` }
}
// Approved on three different days a week apart: a weekly rhythm, and enough to be offered.
const weekly = [human('2026-11-01'), human('2026-11-08'), human('2026-11-15')]

function world(script: Record<string, Scripted[]>) {
  const fake = fakeSupabase(script)
  state.client = fake.client
  return fake
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-23T12:30:00Z'))
})

const quietFacts = { failedByTeam: {}, rejectedDraftAccounts: 0, ownerrezNeedingContact: 0, waitingForApproval: 0, openLeadGenTasks: 0, openSalesOpsTasks: 0 }
const failingFacts = { ...quietFacts, failedByTeam: { lead_gen: 2 } }
const granted = (kind: string, last: string | null = null) => ({ data: [{ action_kind: kind, standing: true, last_standing_run_at: last }], error: null })

/** The queries planStanding makes, in order: the standing runs already made today, then the history the learning reads. */
function plannedWorld(input: { today?: number; history?: unknown[]; playbook: { data: unknown[]; error: null }; waiting?: number }) {
  return world({
    'gtm_team_settings:select':    [settingsOn],
    'agent_tasks:select':          [{ count: input.waiting ?? 0, error: null }],
    'manager_instructions:select': [{ count: input.today ?? 0, error: null }, { data: input.history ?? [], error: null }],
    'manager_playbook:select':     [input.playbook],
  })
}

describe('planStanding', () => {
  it('does nothing when the manager is switched off', async () => {
    world({ 'gtm_team_settings:select': [{ data: [on('global')], error: null }] })
    expect(await planStanding()).toMatchObject({ skip: 'manager_off', due: [] })
  })

  it('does nothing when no type has been granted', async () => {
    plannedWorld({ playbook: { data: [], error: null } })
    expect(await planStanding()).toMatchObject({ skip: 'none_due', due: [] })
  })

  it('does nothing for a type whose playbook row is not switched on', async () => {
    plannedWorld({ history: weekly, playbook: { data: [{ action_kind: 'run_funnel_report', standing: false, last_standing_run_at: null }], error: null } })
    expect(await planStanding()).toMatchObject({ skip: 'none_due', due: [] })
  })

  it('holds back while a person already has a pile waiting', async () => {
    plannedWorld({ waiting: 10, playbook: { data: [], error: null } })
    expect(await planStanding()).toMatchObject({ skip: 'inbox_full', due: [] })
  })

  it('stops at the daily ceiling on its own initiative', async () => {
    plannedWorld({ today: 6, history: weekly, playbook: granted('run_funnel_report') })
    expect(await planStanding()).toMatchObject({ skip: 'daily_cap', due: [] })
  })

  it('runs only as many as the ceiling has room for', async () => {
    state.facts.mockResolvedValue(failingFacts)
    plannedWorld({
      today: 5,
      history: weekly,
      playbook: { data: [
        { action_kind: 'run_funnel_report', standing: true, last_standing_run_at: null },
        { action_kind: 'requeue_failed', standing: true, last_standing_run_at: null },
      ], error: null },
    })
    const plan = await planStanding()
    expect(plan.due).toHaveLength(1)
  })

  it('runs a schedule type once the person\'s own rhythm says it is due, without reading the counts', async () => {
    plannedWorld({ history: weekly, playbook: granted('run_funnel_report') })
    const plan = await planStanding()
    expect(plan.due).toEqual([{ kind: 'run_funnel_report', cadenceDays: 7 }])
    expect(state.facts).not.toHaveBeenCalled()
  })

  it('does not run a schedule type again before the cadence has passed', async () => {
    plannedWorld({ history: weekly, playbook: granted('run_funnel_report', '2026-11-20T12:30:00Z') })
    expect(await planStanding()).toMatchObject({ skip: 'none_due', due: [] })
  })

  it('runs a condition type when its condition is true, and not when it is not', async () => {
    state.facts.mockResolvedValue(failingFacts)
    plannedWorld({ playbook: granted('requeue_failed') })
    expect((await planStanding()).due.map((d) => d.kind)).toEqual(['requeue_failed'])

    state.facts.mockResolvedValue(quietFacts)
    plannedWorld({ playbook: granted('requeue_failed') })
    expect(await planStanding()).toMatchObject({ skip: 'none_due', due: [] })
  })

  it('does not run a condition type inside its minimum gap, however true it stays', async () => {
    state.facts.mockResolvedValue(failingFacts)
    plannedWorld({ playbook: granted('requeue_failed', '2026-11-23T20:00:00Z') })   // 16h before 12:30, gap is 24h
    expect(await planStanding()).toMatchObject({ skip: 'none_due', due: [] })
  })

  it('counts a person\'s decisions on the manager\'s plans toward the rhythm it reads', async () => {
    const plans = weekly.map((h) => ({ ...h, source: 'manager' }))
    plannedWorld({ history: plans, playbook: granted('run_funnel_report') })
    expect((await planStanding()).due).toEqual([{ kind: 'run_funnel_report', cadenceDays: 7 }])
  })
})

describe('runStanding', () => {
  const plan: StandingPlan = { skip: null, due: [], dateKey: '2026-11-23', nowIso: '2026-11-23T12:30:00.000Z' }

  it('applies the action, records it once per kind per day, and stamps the run', async () => {
    state.apply.mockResolvedValue({ kind: 'run_funnel_report', ok: true, summary: 'Asked Rev Ops for a funnel report.' })
    const fake = world({ 'manager_instructions:insert': [{ error: null }], 'manager_playbook:update': [{ error: null }] })
    expect(await runStanding('run_funnel_report', plan)).toEqual({ recorded: true })
    const insert = fake.calls.find((c) => c.op === 'insert')!
    expect(insert.payload).toMatchObject({
      source: 'standing', status: 'applied', action_kinds: ['run_funnel_report'], dedupe_key: 'standing:run_funnel_report:2026-11-23',
    })
    expect(fake.calls.find((c) => c.table === 'manager_playbook')!.payload).toMatchObject({ last_standing_run_at: plan.nowIso })
  })

  it('treats a repeat of the same day\'s record as already done, not as an error', async () => {
    state.apply.mockResolvedValue({ kind: 'run_funnel_report', ok: true, summary: 'x' })
    world({
      'manager_instructions:insert': [{ error: { code: '23505', message: 'dup' } }],
      'manager_playbook:update':     [{ error: null }],
    })
    expect(await runStanding('run_funnel_report', plan)).toEqual({ recorded: false })
  })

  it('records a refusal as failed so the history shows it', async () => {
    state.apply.mockResolvedValue({ kind: 'run_funnel_report', ok: false, summary: 'That team is switched off, so nothing was queued.' })
    const fake = world({ 'manager_instructions:insert': [{ error: null }], 'manager_playbook:update': [{ error: null }] })
    await runStanding('run_funnel_report', plan)
    expect(fake.calls.find((c) => c.op === 'insert')!.payload).toMatchObject({ status: 'failed' })
  })
})
