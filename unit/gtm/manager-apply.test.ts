import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})), send: vi.fn() } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const mocks = vi.hoisted(() => ({
  enqueueTask:      vi.fn(),
  loadTeamSettings: vi.fn(),
}))
vi.mock('@/lib/gtm/tasks', () => ({ enqueueTask: mocks.enqueueTask, loadTeamSettings: mocks.loadTeamSettings }))

import { applyAction, MAX_REQUEUE_PER_RUN } from '@/lib/gtm/manager/apply'
import { fakeSupabase } from './fake-supabase'

// ============================================================================
// The one place an instruction becomes work. Whatever a person approved or the
// manager repeats on its own, it queues a task that still waits for a person,
// through the same enqueue path every other team uses.
// ============================================================================

const ctx = { now: new Date('2026-11-23T13:00:00Z'), origin: 'manager' as const }
const on = (team: string) => ({ team, enabled: true, autonomy: 'propose_only', daily_task_cap: 10, daily_cost_cap_cents: 100 })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadTeamSettings.mockResolvedValue([on('global'), on('sales_ops'), on('lead_gen')])
})

describe('queueing actions', () => {
  it('asks Rev Ops for a report that still needs approval, once per Central day', async () => {
    mocks.enqueueTask.mockResolvedValue({ ok: true, id: 't1' })
    const out = await applyAction(fakeSupabase({}).client, { kind: 'run_funnel_report', params: {}, summary: '' }, ctx)
    expect(out).toMatchObject({ kind: 'run_funnel_report', ok: true })
    expect(mocks.enqueueTask.mock.calls[0][1]).toMatchObject({
      team: 'rev_ops', taskType: 'weekly_funnel_report', origin: 'manager', requiresApproval: true,
      dedupeKey: 'rev_ops:weekly_funnel_report:manager:2026-11-23',
    })
  })

  it('asks Lead Gen for queue candidates the same way', async () => {
    mocks.enqueueTask.mockResolvedValue({ ok: true, id: 't2' })
    await applyAction(fakeSupabase({}).client, { kind: 'propose_queue_candidates', params: {}, summary: '' }, ctx)
    expect(mocks.enqueueTask.mock.calls[0][1]).toMatchObject({
      team: 'lead_gen', origin: 'manager', requiresApproval: true,
      dedupeKey: 'lead_gen:queue_candidates:manager:2026-11-23',
    })
  })

  it('treats "already queued today" as done, and a switched-off team as not done', async () => {
    const client = fakeSupabase({}).client
    mocks.enqueueTask.mockResolvedValueOnce({ ok: false, reason: 'duplicate' })
    expect(await applyAction(client, { kind: 'run_funnel_report', params: {}, summary: '' }, ctx)).toMatchObject({ ok: true })
    mocks.enqueueTask.mockResolvedValueOnce({ ok: false, reason: 'team_off' })
    expect(await applyAction(client, { kind: 'run_funnel_report', params: {}, summary: '' }, ctx)).toMatchObject({ ok: false })
  })
})

describe('requeue_failed', () => {
  it('puts failed tasks back with its own status precondition, resetting attempts and the error', async () => {
    const fake = fakeSupabase({
      'agent_tasks:select': [{ data: [{ id: 'a', team: 'sales_ops' }, { id: 'b', team: 'sales_ops' }], error: null }],
      'agent_tasks:update': [{ data: [{ id: 'a' }, { id: 'b' }], error: null }],
    })
    const out = await applyAction(fake.client, { kind: 'requeue_failed', params: {}, summary: '' }, ctx)
    expect(out.summary).toBe('Put 2 failed tasks back in the queue for another try.')
    const update = fake.calls.find((c) => c.op === 'update')!
    expect(update.payload).toMatchObject({ status: 'pending', attempts: 0, error: null, claimed_at: null })
    expect(update.filters).toContainEqual(['eq', ['status', 'failed']])
    expect(update.filters).toContainEqual(['in', ['id', ['a', 'b']]])
  })

  it('bounds how many one run puts back', async () => {
    const fake = fakeSupabase({
      'agent_tasks:select': [{ data: [], error: null }],
    })
    await applyAction(fake.client, { kind: 'requeue_failed', params: {}, summary: '' }, ctx)
    expect(fake.calls[0].filters).toContainEqual(['limit', [MAX_REQUEUE_PER_RUN]])
  })

  it('limits to one team when asked', async () => {
    const fake = fakeSupabase({ 'agent_tasks:select': [{ data: [], error: null }] })
    await applyAction(fake.client, { kind: 'requeue_failed', params: { team: 'lead_gen' }, summary: '' }, ctx)
    expect(fake.calls[0].filters).toContainEqual(['eq', ['team', 'lead_gen']])
  })

  it('leaves a task failed when its team is switched off, rather than parking it and calling it retried', async () => {
    const fake = fakeSupabase({
      'agent_tasks:select': [{ data: [{ id: 'a', team: 'rev_ops' }], error: null }],
    })
    const out = await applyAction(fake.client, { kind: 'requeue_failed', params: {}, summary: '' }, ctx)
    expect(out.summary).toBe('No failed tasks needed another try.')
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false)
  })
})
