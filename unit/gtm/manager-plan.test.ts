import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})), send: vi.fn() } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const state = vi.hoisted(() => ({ client: null as unknown, facts: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.client }))
vi.mock('@/lib/gtm/manager/facts', () => ({ loadInstructionFacts: state.facts }))

import { gatherPlan, writePlan, type PlanGather } from '@/lib/inngest/functions/gtm-manager-plan'
import { fakeSupabase, type Scripted } from './fake-supabase'

// ============================================================================
// The manager's morning plan. It PROPOSES: the questions that matter are when it
// stays quiet (off, inbox full, a plan already waiting, nothing warranted) and
// that what it writes is a proposal for a person, never work already queued.
// ============================================================================

const on = (team: string) => ({ team, enabled: true, autonomy: 'propose_only', daily_task_cap: 10, daily_cost_cap_cents: 100 })
const settingsOn = { data: [on('global'), on('manager')], error: null }
const quiet = { failedByTeam: {}, rejectedDraftAccounts: 0, ownerrezNeedingContact: 0, waitingForApproval: 0, openLeadGenTasks: 0, openSalesOpsTasks: 0 }
const busy = { ...quiet, failedByTeam: { lead_gen: 3 }, rejectedDraftAccounts: 2, ownerrezNeedingContact: 31 }

function world(script: Record<string, Scripted[]>) {
  const fake = fakeSupabase(script)
  state.client = fake.client
  return fake
}

/** gatherPlan reads, in order: how many plans already wait, then the history, then the playbook. */
function planWorld(input: { waitingPlans?: number; history?: unknown[]; playbook?: unknown[] }) {
  return world({
    'gtm_team_settings:select':    [settingsOn],
    'manager_instructions:select': [{ count: input.waitingPlans ?? 0, error: null }, { data: input.history ?? [], error: null }],
    'manager_playbook:select':     [{ data: input.playbook ?? [], error: null }],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-24T12:20:00Z'))
})

describe('gatherPlan', () => {
  it('stays quiet when the manager is switched off', async () => {
    world({ 'gtm_team_settings:select': [{ data: [on('global')], error: null }] })
    expect(await gatherPlan()).toMatchObject({ skip: 'manager_off', actions: [] })
    expect(state.facts).not.toHaveBeenCalled()
  })

  it('stays quiet while a person already has a pile waiting', async () => {
    state.facts.mockResolvedValue({ ...busy, waitingForApproval: 10 })
    world({ 'gtm_team_settings:select': [settingsOn] })
    expect(await gatherPlan()).toMatchObject({ skip: 'inbox_full', actions: [] })
  })

  it('stays quiet while yesterday\'s plan is still waiting for an answer', async () => {
    state.facts.mockResolvedValue(busy)
    planWorld({ waitingPlans: 1 })
    expect(await gatherPlan()).toMatchObject({ skip: 'plan_waiting', actions: [] })
  })

  it('stays quiet when nothing is warranted', async () => {
    state.facts.mockResolvedValue(quiet)
    planWorld({})
    expect(await gatherPlan()).toMatchObject({ skip: 'nothing_warranted', actions: [] })
  })

  it('proposes what the counts call for, with the reason for each', async () => {
    state.facts.mockResolvedValue(busy)
    planWorld({})
    const out = await gatherPlan()
    expect(out.skip).toBeNull()
    expect(out.actions.map((a) => a.kind)).toEqual(['requeue_failed', 'redraft_rejected', 'enrich_ownerrez'])
    expect(out.reasons[0]).toContain('3 tasks failed')
    expect(out.dateKey).toBe('2026-11-24')
  })

  it('leaves out a type already handed over, and a type rejected this week', async () => {
    state.facts.mockResolvedValue(busy)
    planWorld({
      history:  [{ source: 'manager', status: 'rejected', action_kinds: ['enrich_ownerrez'], decided_at: '2026-11-22T10:00:00Z' }],
      playbook: [{ action_kind: 'requeue_failed', standing: true, last_standing_run_at: null }],
    })
    const out = await gatherPlan()
    expect(out.actions.map((a) => a.kind)).toEqual(['redraft_rejected'])
  })
})

describe('writePlan', () => {
  const gathered: PlanGather = {
    skip: null,
    actions: [{ kind: 'requeue_failed', params: {}, summary: 'Retry failed tasks' }],
    reasons: ['Retry failed tasks: 3 tasks failed in the last 7 days.'],
    dateKey: '2026-11-24',
  }

  it('writes a PROPOSAL for a person, keyed per day, and queues nothing itself', async () => {
    const fake = world({ 'manager_instructions:insert': [{ error: null }] })
    expect(await writePlan(gathered)).toEqual({ written: true })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].table).toBe('manager_instructions')
    expect(fake.calls[0].payload).toMatchObject({
      source: 'manager', status: 'proposed', action_kinds: ['requeue_failed'], dedupe_key: 'plan:2026-11-24',
    })
  })

  it('treats a plan already written today as done, not as an error', async () => {
    world({ 'manager_instructions:insert': [{ error: { code: '23505', message: 'dup' } }] })
    expect(await writePlan(gathered)).toEqual({ written: false })
  })

  it('fails loudly on any other write error', async () => {
    world({ 'manager_instructions:insert': [{ error: { code: '42501', message: 'denied' } }] })
    await expect(writePlan(gathered)).rejects.toMatchObject({ code: '42501' })
  })
})
