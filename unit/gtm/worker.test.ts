import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
import { workOne, type HandlerRegistry } from '@/lib/gtm/worker'
import type { AgentTask } from '@/types/database'
import { fakeSupabase, type Scripted } from './fake-supabase'

const NOW = new Date('2026-11-18T20:00:00Z')

const setting = (team: string, enabled: boolean, over: Record<string, unknown> = {}) =>
  ({ team, enabled, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 100, ...over })
const ON = [setting('global', true), setting('rev_ops', true)]

const row = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 't1', team: 'rev_ops', task_type: 'weekly_funnel_report', prospect_id: null, status: 'in_progress', priority: 50,
  input: {}, output: null, requires_approval: true, origin: 'rev_ops', parent_task_id: null, depth: 0, dedupe_key: null,
  attempts: 0, max_attempts: 3, error: null, decided_by: null, decided_at: null, decision_note: null, claimed_at: null,
  completed_at: null, created_at: '2026-11-18T12:00:00Z', updated_at: '2026-11-18T12:00:00Z', ...over,
})

const NO_SPEND = { data: { funnel: {}, touches: {}, tasks: [], spend: [] } }

function world(opts: {
  settings?: unknown[]
  rpc?: { data?: unknown; error?: { message: string } | null }
  selects?: Scripted[]
  updates?: Scripted[]
}) {
  return fakeSupabase({
    'gtm_team_settings:select': [{ data: opts.settings ?? ON, error: null }],
    'agent_tasks:select':       opts.selects ?? [{ data: null, error: null }],
    'agent_tasks:update':       opts.updates ?? [{ data: null, error: null }],
  }, [opts.rpc ?? NO_SPEND])
}

function registry(over: Partial<{ run: () => Promise<never>; execute: () => Promise<never> }> = {}) {
  const run = vi.fn(async () => ({ kind: 'propose' as const, output: { summary: 'draft' } }))
  const execute = vi.fn(async () => ({ output: { done: true } }))
  const reg: HandlerRegistry = { weekly_funnel_report: { run: (over.run ?? run) as never, execute: (over.execute ?? execute) as never } }
  return { reg, run, execute }
}

beforeEach(() => { vi.clearAllMocks() })

describe('workOne: whether to work at all', () => {
  it('does nothing while the master switch is off, and claims no task', async () => {
    const { client, calls } = world({ settings: [setting('global', false), setting('rev_ops', true)] })
    expect(await workOne(client, 'rev_ops', registry().reg, NOW)).toEqual({ worked: false, reason: 'team_off' })
    expect(calls.some((c) => c.table === 'agent_tasks')).toBe(false)
  })

  it('does nothing for a team that is switched off', async () => {
    const { client } = world({ settings: [setting('global', true), setting('rev_ops', false)] })
    expect(await workOne(client, 'rev_ops', registry().reg, NOW)).toEqual({ worked: false, reason: 'team_off' })
  })

  it('does nothing for a team with no settings row at all', async () => {
    const { client } = world({ settings: [setting('global', true)] })
    expect(await workOne(client, 'rev_ops', registry().reg, NOW)).toEqual({ worked: false, reason: 'team_off' })
  })

  it('stops once the team has spent its daily budget', async () => {
    const { client, calls } = world({ rpc: { data: { spend: [{ team: 'rev_ops', cost_cents: 100, calls: 4 }] } } })
    expect(await workOne(client, 'rev_ops', registry().reg, NOW)).toEqual({ worked: false, reason: 'cost_cap' })
    expect(calls.some((c) => c.table === 'agent_tasks')).toBe(false)
  })

  // If the spend cannot be seen, it cannot be promised to be under the cap.
  it('treats an unreadable spend ledger as over budget', async () => {
    const { client } = world({ rpc: { error: { message: 'boom' } } })
    expect(await workOne(client, 'rev_ops', registry().reg, NOW)).toEqual({ worked: false, reason: 'cost_cap' })
  })

  it('claims nothing outside 8am to 6pm Central, so the queue keeps until the window opens', async () => {
    const { client, calls } = world({})
    const lateEvening = new Date('2026-11-20T01:00:00Z') // 7pm CST
    expect(await workOne(client, 'rev_ops', registry().reg, lateEvening)).toEqual({ worked: false, reason: 'off_hours' })
    expect(calls.some((c) => c.table === 'agent_tasks')).toBe(false)
  })

  it('reports an empty queue', async () => {
    const { client } = world({ selects: [{ data: null, error: null }] })
    expect(await workOne(client, 'rev_ops', registry().reg, NOW)).toEqual({ worked: false, reason: 'empty' })
  })
})

describe('workOne: doing new work', () => {
  it('sends a proposal to the approval inbox on a propose-only team', async () => {
    const { reg, run } = registry()
    const { client, calls } = world({
      selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }], // nothing approved, one pending
      updates: [{ data: row(), error: null }, { data: { id: 't1' }, error: null }],   // claim, then complete
    })
    expect(await workOne(client, 'rev_ops', reg, NOW)).toMatchObject({ worked: true, stage: 'pending', result: 'proposed' })
    expect(run).toHaveBeenCalledTimes(1)
    const complete = calls.filter((c) => c.op === 'update')[1].payload
    expect(complete).toMatchObject({ status: 'needs_approval', output: { summary: 'draft' } })
  })

  it('approves it straight away when the manager is running and the team is set to auto, recording the decision', async () => {
    const auto = [setting('global', true), setting('manager', true), setting('rev_ops', true, { autonomy: 'auto_low_risk' })]
    const { reg } = registry()
    const w = world({ settings: auto, selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }],
      updates: [{ data: row(), error: null }, { data: { id: 't1' }, error: null }] })
    expect(await workOne(w.client, 'rev_ops', reg, NOW)).toMatchObject({ worked: true, result: 'proposed' })
    const complete = w.calls.filter((c) => c.op === 'update')[1].payload
    expect(complete).toMatchObject({ status: 'approved', decided_at: NOW.toISOString() })
    expect(complete).not.toHaveProperty('decided_by')
  })

  it('lets a team allowed to finish low-risk work finish it, but only when the task did not ask for review', async () => {
    const auto = [setting('global', true), setting('rev_ops', true, { autonomy: 'auto_low_risk' })]
    const { reg } = registry()
    const open = world({ settings: auto, selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }],
      updates: [{ data: row({ requires_approval: false }), error: null }, { data: { id: 't1' }, error: null }] })
    await workOne(open.client, 'rev_ops', reg, NOW)
    expect(open.calls.filter((c) => c.op === 'update')[1].payload).toMatchObject({ status: 'done' })

    const review = world({ settings: auto, selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }],
      updates: [{ data: row({ requires_approval: true }), error: null }, { data: { id: 't1' }, error: null }] })
    await workOne(review.client, 'rev_ops', reg, NOW)
    expect(review.calls.filter((c) => c.op === 'update')[1].payload).toMatchObject({ status: 'needs_approval' })
  })

  it('closes a "nothing to propose" result as done, without asking anyone to approve it', async () => {
    const { reg } = registry({ run: (async () => ({ kind: 'nothing', output: { reason: 'no_contact_found' } })) as never })
    const { client, calls } = world({
      selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }],
      updates: [{ data: row(), error: null }, { data: { id: 't1' }, error: null }],
    })
    expect(await workOne(client, 'rev_ops', reg, NOW)).toMatchObject({ result: 'nothing' })
    expect(calls.filter((c) => c.op === 'update')[1].payload).toMatchObject({ status: 'done', output: { reason: 'no_contact_found' } })
  })

  it('reports a lost claim instead of pretending it recorded the work', async () => {
    const { client } = world({
      selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }],
      updates: [{ data: row(), error: null }, { data: null, error: null }],
    })
    expect(await workOne(client, 'rev_ops', registry().reg, NOW)).toMatchObject({ result: 'lost_claim' })
  })
})

describe('workOne: carrying out an approved proposal', () => {
  const approvedRow = row({ decided_at: '2026-11-18T13:00:00Z', decided_by: 'admin_1' })

  it('takes approved work BEFORE new work, executes it, and finishes it as done', async () => {
    const { reg, run, execute } = registry()
    const { client, calls } = world({
      selects: [{ data: { id: 't1' }, error: null }],                                          // an approved task exists
      updates: [{ data: approvedRow, error: null }, { data: { id: 't1' }, error: null }],       // claim, then finish
    })
    expect(await workOne(client, 'rev_ops', reg, NOW)).toMatchObject({ stage: 'approved', result: 'executed' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    const selects = calls.filter((c) => c.table === 'agent_tasks' && c.op === 'select')
    expect(selects[0].filters).toContainEqual(['eq', ['status', 'approved']])
    expect(calls.filter((c) => c.op === 'update')[1].payload).toMatchObject({ status: 'done', output: { done: true } })
  })
})

describe('workOne: a team whose drafts a person finishes', () => {
  const draftsOnly = (): HandlerRegistry => ({ draft_outreach: { run: vi.fn(async () => ({ kind: 'propose' as const, output: {} })) } })
  const approvedClaims = (calls: { table: string; op: string; filters: [string, unknown[]][] }[]) =>
    calls.filter((c) => c.table === 'agent_tasks' && c.op === 'select' && c.filters.some(([f, a]) => f === 'eq' && a[1] === 'approved'))

  // An approved draft is waiting for a person to send it. A worker that claimed it would have nothing to do with it.
  it('never looks for approved work when no task type has an execute step', async () => {
    const { client, calls } = world({ selects: [{ data: null, error: null }] })
    expect(await workOne(client, 'rev_ops', draftsOnly(), NOW)).toEqual({ worked: false, reason: 'empty' })
    expect(approvedClaims(calls)).toHaveLength(0)
  })

  it('looks for approved work only among the types that can be executed', async () => {
    const mixed: HandlerRegistry = { ...draftsOnly(), weekly_funnel_report: { run: vi.fn(), execute: vi.fn() } }
    const { client, calls } = world({ selects: [{ data: null, error: null }] })
    await workOne(client, 'rev_ops', mixed, NOW)
    const approved = approvedClaims(calls)[0]
    expect(approved.filters).toContainEqual(['in', ['task_type', ['weekly_funnel_report']]])
  })
})

describe('workOne: failures', () => {
  it('retries a task whose work threw: back to pending, attempt counted, reported', async () => {
    const { reg } = registry({ run: (async () => { throw new Error('site down') }) as never })
    const { client, calls } = world({
      selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }],
      updates: [{ data: row(), error: null }, { data: { id: 't1' }, error: null }],
    })
    expect(await workOne(client, 'rev_ops', reg, NOW)).toMatchObject({ result: 'failed' })
    expect(calls.filter((c) => c.op === 'update')[1].payload).toMatchObject({ status: 'pending', attempts: 1, error: 'site down' })
    expect(reportError).toHaveBeenCalled()
  })

  // Sent back to 'pending' it would redo the research and ask for the same approval twice.
  it('puts a failed APPLICATION back at approved, not at the start', async () => {
    const { reg } = registry({ execute: (async () => { throw new Error('db blip') }) as never })
    const { client, calls } = world({
      selects: [{ data: { id: 't1' }, error: null }],
      updates: [{ data: row({ decided_at: '2026-11-18T13:00:00Z' }), error: null }, { data: { id: 't1' }, error: null }],
    })
    await workOne(client, 'rev_ops', reg, NOW)
    expect(calls.filter((c) => c.op === 'update')[1].payload).toMatchObject({ status: 'approved', attempts: 1 })
  })

  it('fails for good, and announces it, once the last attempt is spent', async () => {
    const { reg } = registry({ run: (async () => { throw new Error('still down') }) as never })
    const { client, calls } = world({
      selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }],
      updates: [{ data: row({ attempts: 2 }), error: null }, { data: { id: 't1' }, error: null }],
    })
    await workOne(client, 'rev_ops', reg, NOW)
    expect(calls.filter((c) => c.op === 'update')[1].payload).toMatchObject({ status: 'failed', attempts: 3 })
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'gtm/task.failed' }))
  })

  it('fails an unknown task type immediately instead of retrying what can never work', async () => {
    const { client, calls } = world({
      selects: [{ data: null, error: null }, { data: { id: 't1' }, error: null }],
      updates: [{ data: row({ task_type: 'mystery' }), error: null }, { data: { id: 't1' }, error: null }],
    })
    expect(await workOne(client, 'rev_ops', registry().reg, NOW)).toMatchObject({ result: 'failed', taskType: 'mystery' })
    expect(calls.filter((c) => c.op === 'update')[1].payload).toMatchObject({ status: 'failed' })
  })
})
