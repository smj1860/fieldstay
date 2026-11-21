import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
import { checkBudget, claimNextTask, completeTask, enqueueTask, failTask, recordUsage } from '@/lib/gtm/tasks'
import { fakeSupabase } from './fake-supabase'

const NOW = new Date('2026-11-18T20:00:00Z')
const setting = (team: string, enabled: boolean, extra: Record<string, unknown> = {}) =>
  ({ team, enabled, autonomy: 'propose_only', daily_task_cap: 10, daily_cost_cap_cents: 100, ...extra })

const ALL_ON = [setting('global', true), setting('lead_gen', true), setting('manager', true)]
const ZERO_SPEND = { data: { funnel: {}, touches: {}, tasks: [], spend: [] } }

beforeEach(() => { vi.clearAllMocks() })

describe('enqueueTask', () => {
  const input = { team: 'lead_gen', taskType: 'enrich_account', origin: 'manager', now: NOW } as const

  function world(overrides: { settings?: unknown[]; count?: number; rpc?: { data?: unknown; error?: { message: string } | null }; insert?: unknown } = {}) {
    return fakeSupabase({
      'gtm_team_settings:select': [{ data: overrides.settings ?? ALL_ON, error: null }],
      'agent_tasks:select':       [{ count: overrides.count ?? 0, error: null }],
      'agent_tasks:insert':       [(overrides.insert ?? { data: { id: 'task-1' }, error: null }) as never],
    }, [overrides.rpc ?? ZERO_SPEND])
  }

  it('queues a task for a team that is running and under budget, and announces it', async () => {
    const { client, calls } = world()
    expect(await enqueueTask(client, input)).toEqual({ ok: true, id: 'task-1' })

    const insert = calls.find((c) => c.op === 'insert')!
    expect(insert.payload).toMatchObject({ team: 'lead_gen', task_type: 'enrich_account', depth: 0, requires_approval: true })
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'gtm/task.created',
      data: { task_id: 'task-1', team: 'lead_gen', task_type: 'enrich_account', prospect_id: null, requires_approval: true },
    })
  })

  it('does nothing for a team that is switched off, and writes no row', async () => {
    const { client, calls } = world({ settings: [setting('global', true), setting('lead_gen', false)] })
    expect(await enqueueTask(client, input)).toEqual({ ok: false, reason: 'team_off' })
    expect(calls.some((c) => c.op === 'insert')).toBe(false)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('does nothing while the master switch is off, even for an enabled team', async () => {
    const { client } = world({ settings: [setting('global', false), setting('lead_gen', true)] })
    expect(await enqueueTask(client, input)).toEqual({ ok: false, reason: 'team_off' })
  })

  it('refuses work spawned beyond the depth ceiling', async () => {
    const { client } = world()
    expect(await enqueueTask(client, { ...input, parent: { id: 'p', depth: 4 } })).toEqual({ ok: false, reason: 'too_deep' })
  })

  it('records the chain: a child is one deeper than its parent and names it', async () => {
    const { client, calls } = world()
    await enqueueTask(client, { ...input, parent: { id: 'parent-1', depth: 2 } })
    expect(calls.find((c) => c.op === 'insert')!.payload).toMatchObject({ depth: 3, parent_task_id: 'parent-1' })
  })

  it('stops at the daily task cap', async () => {
    const { client, calls } = world({ count: 10 })
    expect(await enqueueTask(client, input)).toEqual({ ok: false, reason: 'task_cap' })
    expect(calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('stops at the daily spend cap', async () => {
    const { client } = world({ rpc: { data: { spend: [{ team: 'lead_gen', cost_cents: 100, calls: 4 }] } } })
    expect(await enqueueTask(client, input)).toEqual({ ok: false, reason: 'cost_cap' })
  })

  // If the spend cannot be seen, it cannot be promised to be under the cap.
  it('treats an unreadable spend ledger as over budget, and says so', async () => {
    const { client } = world({ rpc: { error: { message: 'boom' } } })
    expect(await enqueueTask(client, input)).toEqual({ ok: false, reason: 'cost_cap' })
    expect(reportError).toHaveBeenCalled()
  })

  it('reads a team with no settings row as having no budget, not an unlimited one', async () => {
    const { client } = fakeSupabase({})
    expect(await checkBudget(client, [], 'lead_gen', NOW)).toBe('task_cap')
  })

  it('reports a replayed dedupe key as a duplicate, not an error', async () => {
    const { client } = world({ insert: { data: null, error: { code: '23505', message: 'duplicate key' } } })
    expect(await enqueueTask(client, { ...input, dedupeKey: 'k' })).toEqual({ ok: false, reason: 'duplicate' })
    expect(inngest.send).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
  })

  it('throws, and reports, on any other insert failure', async () => {
    const { client } = world({ insert: { data: null, error: { code: '42501', message: 'denied' } } })
    await expect(enqueueTask(client, input)).rejects.toMatchObject({ code: '42501' })
    expect(reportError).toHaveBeenCalled()
  })

  it('keeps the task if the wake-up event cannot be sent', async () => {
    vi.mocked(inngest.send).mockRejectedValueOnce(new Error('inngest down'))
    const { client } = world()
    expect(await enqueueTask(client, input)).toEqual({ ok: true, id: 'task-1' })
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ level: 'warning' }))
  })
})

describe('claimNextTask', () => {
  it('returns null when the queue is empty', async () => {
    const { client } = fakeSupabase({ 'agent_tasks:select': [{ data: null, error: null }] })
    expect(await claimNextTask(client, 'lead_gen')).toBeNull()
  })

  it('claims only a still-pending row, highest priority and oldest first', async () => {
    const { client, calls } = fakeSupabase({
      'agent_tasks:select': [{ data: { id: 't1' }, error: null }],
      'agent_tasks:update': [{ data: { id: 't1', status: 'in_progress' }, error: null }],
    })
    expect(await claimNextTask(client, 'lead_gen')).toMatchObject({ id: 't1' })

    const pick = calls.find((c) => c.op === 'select')!
    expect(pick.filters).toContainEqual(['eq', ['status', 'pending']])
    expect(pick.filters).toContainEqual(['order', ['priority', { ascending: false }]])
    // The guard that makes the claim safe is on the UPDATE, not the select before it.
    const claim = calls.find((c) => c.op === 'update')!
    expect(claim.filters).toContainEqual(['eq', ['status', 'pending']])
    expect(claim.payload).toMatchObject({ status: 'in_progress' })
  })

  it('can be limited to task types, so a task whose last step is a person\'s is never claimed', async () => {
    const { client, calls } = fakeSupabase({
      'agent_tasks:select': [{ data: { id: 't1' }, error: null }],
      'agent_tasks:update': [{ data: { id: 't1' }, error: null }],
    })
    await claimNextTask(client, 'rev_ops', 'approved', ['weekly_funnel_report'])
    expect(calls.find((c) => c.op === 'select')!.filters).toContainEqual(['in', ['task_type', ['weekly_funnel_report']]])
  })

  it('takes any type when none is named', async () => {
    const { client, calls } = fakeSupabase({ 'agent_tasks:select': [{ data: null, error: null }] })
    await claimNextTask(client, 'rev_ops')
    expect(calls.find((c) => c.op === 'select')!.filters.some(([f]) => f === 'in')).toBe(false)
  })

  it('looks again after losing a race, rather than reporting an empty queue', async () => {
    const { client, calls } = fakeSupabase({
      'agent_tasks:select': [{ data: { id: 't1' }, error: null }, { data: { id: 't2' }, error: null }],
      'agent_tasks:update': [{ data: null, error: null }, { data: { id: 't2' }, error: null }],
    })
    expect(await claimNextTask(client, 'lead_gen')).toMatchObject({ id: 't2' })
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(2)
  })

  it('gives up after a few lost races instead of spinning', async () => {
    const { client, calls } = fakeSupabase({
      'agent_tasks:select': [{ data: { id: 't1' }, error: null }],
      'agent_tasks:update': [{ data: null, error: null }],
    })
    expect(await claimNextTask(client, 'lead_gen')).toBeNull()
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(3)
  })
})

describe('completeTask', () => {
  const task = { id: 't1', requires_approval: false }

  it('sends a propose-only team\'s output to the approval inbox even when the task did not ask', async () => {
    const { client, calls } = fakeSupabase({ 'agent_tasks:update': [{ data: { id: 't1' }, error: null }] })
    expect(await completeTask(client, task, { body: 'draft' }, 'propose_only')).toEqual({ ok: true, status: 'needs_approval' })
    expect(calls[0].payload).toMatchObject({ status: 'needs_approval', completed_at: null })
  })

  it('lets a low-risk task finish outright on a team allowed to', async () => {
    const { client, calls } = fakeSupabase({ 'agent_tasks:update': [{ data: { id: 't1' }, error: null }] })
    expect(await completeTask(client, task, {}, 'auto_low_risk')).toEqual({ ok: true, status: 'done' })
    expect(calls[0].payload).toMatchObject({ status: 'done', completed_at: expect.any(String) })
  })

  // A task the stall sweep already took back must not be revived by a slow worker.
  it('only completes a task still held in_progress, and says when it was not', async () => {
    const { client, calls } = fakeSupabase({ 'agent_tasks:update': [{ data: null, error: null }] })
    expect(await completeTask(client, task, {}, 'auto_low_risk')).toMatchObject({ ok: false })
    expect(calls[0].filters).toContainEqual(['eq', ['status', 'in_progress']])
  })
})

describe('failTask', () => {
  const task = { id: 't1', team: 'lead_gen' as const, task_type: 'enrich', attempts: 0, max_attempts: 3 }

  it('puts the task back in the queue while attempts remain, without announcing a failure', async () => {
    const { client, calls } = fakeSupabase({ 'agent_tasks:update': [{ data: { id: 't1' }, error: null }] })
    expect(await failTask(client, task, 'timeout')).toEqual({ terminal: false })
    expect(calls[0].payload).toMatchObject({ attempts: 1, status: 'pending', claimed_at: null, completed_at: null })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('fails for good on the last attempt, and announces it exactly then', async () => {
    const { client, calls } = fakeSupabase({ 'agent_tasks:update': [{ data: { id: 't1' }, error: null }] })
    expect(await failTask(client, { ...task, attempts: 2 }, 'timeout')).toEqual({ terminal: true })
    expect(calls[0].payload).toMatchObject({ attempts: 3, status: 'failed' })
    expect(inngest.send).toHaveBeenCalledWith({ name: 'gtm/task.failed', data: { task_id: 't1', team: 'lead_gen', task_type: 'enrich' } })
  })

  it('does not double-count an attempt the sweep already counted', async () => {
    const { client, calls } = fakeSupabase({ 'agent_tasks:update': [{ data: null, error: null }] })
    expect(await failTask(client, { ...task, attempts: 2 }, 'x')).toEqual({ terminal: false })
    expect(calls[0].filters).toContainEqual(['eq', ['attempts', 2]])
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('truncates a long error so a stack trace cannot bloat the row', async () => {
    const { client, calls } = fakeSupabase({ 'agent_tasks:update': [{ data: { id: 't1' }, error: null }] })
    await failTask(client, task, 'x'.repeat(2_000))
    expect((calls[0].payload as { error: string }).error).toHaveLength(500)
  })
})

describe('recordUsage', () => {
  const usage = { team: 'manager' as const, model: 'claude-haiku-4-5-20251001', inputTokens: 1_000, outputTokens: 500, dedupeKey: 'k' }

  it('writes the spend, priced from the reported tokens', async () => {
    const { client, calls } = fakeSupabase({ 'agent_usage:insert': [{ error: null }] })
    await recordUsage(client, usage)
    expect(calls[0].payload).toMatchObject({ team: 'manager', cost_cents: 0.35, dedupe_key: 'k' })
  })

  it('treats a replayed key as already counted, so a retried step bills once', async () => {
    const { client } = fakeSupabase({ 'agent_usage:insert': [{ error: { code: '23505', message: 'dup' } }] })
    await expect(recordUsage(client, usage)).resolves.toBeUndefined()
    expect(reportError).not.toHaveBeenCalled()
  })

  // Losing a spend row understates the bill, which is the unsafe direction for a cap.
  it('throws on any other failure rather than silently under-counting', async () => {
    const { client } = fakeSupabase({ 'agent_usage:insert': [{ error: { code: '42501', message: 'denied' } }] })
    await expect(recordUsage(client, usage)).rejects.toMatchObject({ code: '42501' })
  })
})
