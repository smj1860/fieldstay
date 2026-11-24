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

describe('redraft_rejected', () => {
  const action = (limit?: number) => ({ kind: 'redraft_rejected' as const, params: limit ? { limit } : {}, summary: '' })
  const queuedOk = () => mocks.enqueueTask.mockResolvedValue({ ok: true, id: 't' })

  it('asks Sales Ops for a fresh draft for accounts it rejected, each needing approval, keyed per account per day', async () => {
    queuedOk()
    const fake = fakeSupabase({
      'agent_tasks:select':       [
        { data: [{ prospect_id: 'p1' }, { prospect_id: 'p2' }, { prospect_id: 'p1' }], error: null },
        { data: [], error: null },
      ],
      'prospect_accounts:select': [{ data: [{ id: 'p1' }, { id: 'p2' }], error: null }],
    })
    const out = await applyAction(fake.client, action(), ctx)
    expect(out.ok).toBe(true)
    expect(out.summary).toContain('redraft 2 accounts')
    expect(mocks.enqueueTask.mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({ team: 'sales_ops', taskType: 'draft_outreach', origin: 'manager', requiresApproval: true, prospectId: 'p1', dedupeKey: 'sales_ops:draft_outreach:p1:redraft:2026-11-23' }),
      expect.objectContaining({ prospectId: 'p2', dedupeKey: 'sales_ops:draft_outreach:p2:redraft:2026-11-23' }),
    ])
  })

  it('skips an account that already has a draft waiting, or that has moved on', async () => {
    queuedOk()
    const fake = fakeSupabase({
      'agent_tasks:select':       [
        { data: [{ prospect_id: 'p1' }, { prospect_id: 'p2' }, { prospect_id: 'p3' }], error: null },
        { data: [{ prospect_id: 'p1' }], error: null },
      ],
      // p3 has replied since: it is not in a draftable stage.
      'prospect_accounts:select': [{ data: [{ id: 'p1' }, { id: 'p2' }], error: null }],
    })
    await applyAction(fake.client, action(), ctx)
    expect(mocks.enqueueTask.mock.calls.map((c) => c[1].prospectId)).toEqual(['p2'])
  })

  it('takes on no more than it was asked for, and never past its own ceiling', async () => {
    queuedOk()
    const rows = Array.from({ length: 9 }, (_, i) => ({ prospect_id: `p${i}` }))
    const ids = rows.map((r) => ({ id: r.prospect_id }))
    const world = () => fakeSupabase({
      'agent_tasks:select':       [{ data: rows, error: null }, { data: [], error: null }],
      'prospect_accounts:select': [{ data: ids, error: null }],
    })
    await applyAction(world().client, action(2), ctx)
    expect(mocks.enqueueTask).toHaveBeenCalledTimes(2)
    mocks.enqueueTask.mockClear()
    await applyAction(world().client, action(), ctx)
    expect(mocks.enqueueTask).toHaveBeenCalledTimes(5)
  })

  it('says so, and queues nothing, when nothing was rejected', async () => {
    const fake = fakeSupabase({ 'agent_tasks:select': [{ data: [], error: null }] })
    const out = await applyAction(fake.client, action(), ctx)
    expect(out).toMatchObject({ ok: true })
    expect(out.summary).toMatch(/nothing to redo/)
    expect(mocks.enqueueTask).not.toHaveBeenCalled()
  })

  it('reports a switched-off team as not done', async () => {
    mocks.enqueueTask.mockResolvedValue({ ok: false, reason: 'team_off' })
    const fake = fakeSupabase({
      'agent_tasks:select':       [{ data: [{ prospect_id: 'p1' }], error: null }, { data: [], error: null }],
      'prospect_accounts:select': [{ data: [{ id: 'p1' }], error: null }],
    })
    expect(await applyAction(fake.client, action(), ctx)).toMatchObject({ ok: false })
  })
})

describe('enrich_ownerrez', () => {
  const action = (limit?: number) => ({ kind: 'enrich_ownerrez' as const, params: limit ? { limit } : {}, summary: '' })

  it('asks Lead Gen about OwnerRez accounts with no email, with the same key Rev Ops uses so none is queued twice', async () => {
    mocks.enqueueTask.mockResolvedValue({ ok: true, id: 't' })
    const fake = fakeSupabase({
      'prospect_accounts:select': [{ data: [{ id: 'p1' }, { id: 'p2' }], error: null }],
      'agent_tasks:select':       [{ data: [{ prospect_id: 'p2' }], error: null }],
    })
    const out = await applyAction(fake.client, action(), ctx)
    expect(out.summary).toContain('1 OwnerRez account')
    const period = Math.floor(ctx.now.getTime() / (30 * 86_400_000))
    expect(mocks.enqueueTask.mock.calls[0][1]).toMatchObject({
      team: 'lead_gen', taskType: 'enrich_account', origin: 'manager', requiresApproval: true, prospectId: 'p1',
      dedupeKey: `lead_gen:enrich_account:p1:${period}`,
    })
    expect(mocks.enqueueTask).toHaveBeenCalledTimes(1)
    const filters = fake.calls[0].filters
    expect(filters).toContainEqual(['ilike', ['pms', 'OwnerRez']])
    expect(filters).toContainEqual(['is', ['email', null]])
  })

  it('stops at its ceiling of ten', async () => {
    mocks.enqueueTask.mockResolvedValue({ ok: true, id: 't' })
    const pool = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}` }))
    const fake = fakeSupabase({
      'prospect_accounts:select': [{ data: pool, error: null }],
      'agent_tasks:select':       [{ data: [], error: null }],
    })
    await applyAction(fake.client, action(), ctx)
    expect(mocks.enqueueTask).toHaveBeenCalledTimes(10)
  })

  it('says so when every one was already looked at, or there are none', async () => {
    const none = fakeSupabase({ 'prospect_accounts:select': [{ data: [], error: null }] })
    expect((await applyAction(none.client, action(), ctx)).summary).toMatch(/No OwnerRez accounts/)
    const seen = fakeSupabase({
      'prospect_accounts:select': [{ data: [{ id: 'p1' }], error: null }],
      'agent_tasks:select':       [{ data: [{ prospect_id: 'p1' }], error: null }],
    })
    expect((await applyAction(seen.client, action(), ctx)).summary).toMatch(/already looked at/)
    expect(mocks.enqueueTask).not.toHaveBeenCalled()
  })
})

describe('draft_meeting_requests', () => {
  const action = (limit?: number) => ({ kind: 'draft_meeting_requests' as const, params: limit ? { limit } : {}, summary: '' })
  const queuedOk = () => mocks.enqueueTask.mockResolvedValue({ ok: true, id: 't' })

  it('asks Sales Ops for a meeting-request draft for each list account with an email, each needing approval', async () => {
    queuedOk()
    const fake = fakeSupabase({
      'prospect_accounts:select': [{ data: [{ id: 'p1', email_status: 'unknown' }, { id: 'p2', email_status: 'valid' }, { id: 'p3', email_status: 'bounced' }], error: null }],
      'agent_tasks:select':       [{ data: [], error: null }],
    })
    const out = await applyAction(fake.client, action(), ctx)
    expect(out.summary).toContain('2 accounts')
    expect(mocks.enqueueTask.mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({ team: 'sales_ops', taskType: 'draft_outreach', origin: 'manager', requiresApproval: true, prospectId: 'p1', input: { intent: 'meeting_request' } }),
      expect.objectContaining({ prospectId: 'p2' }),
    ])
    expect(String(mocks.enqueueTask.mock.calls[0][1].dedupeKey)).toMatch(/^sales_ops:draft_outreach:p1:meeting:\d+$/)
  })

  it('reads only accounts from a founder list that run OwnerRez, and never writes a prospect', async () => {
    queuedOk()
    const fake = fakeSupabase({
      'prospect_accounts:select': [{ data: [], error: null }],
    })
    await applyAction(fake.client, action(), ctx)
    const read = fake.calls.find((c) => c.table === 'prospect_accounts')!
    expect(read.filters).toContainEqual(['like', ['source', 'founder\\_list\\_%']])
    expect(read.filters).toContainEqual(['ilike', ['pms', 'OwnerRez']])
    expect(fake.calls.some((c) => c.table === 'prospect_accounts' && c.op !== 'select')).toBe(false)
  })

  it('skips an account that already has a draft waiting, and says so when nothing is left', async () => {
    queuedOk()
    const fake = fakeSupabase({
      'prospect_accounts:select': [{ data: [{ id: 'p1', email_status: null }, { id: 'p2', email_status: null }], error: null }],
      'agent_tasks:select':       [{ data: [{ prospect_id: 'p1' }, { prospect_id: 'p2' }], error: null }],
    })
    const out = await applyAction(fake.client, action(), ctx)
    expect(out.summary).toContain('already has a draft waiting')
    expect(mocks.enqueueTask).not.toHaveBeenCalled()
  })

  it('says to approve Lead Gen first when no list account has an email yet', async () => {
    const fake = fakeSupabase({ 'prospect_accounts:select': [{ data: [], error: null }] })
    const out = await applyAction(fake.client, action(), ctx)
    expect(out).toMatchObject({ ok: true })
    expect(out.summary).toContain('Approve what Lead Gen finds first')
  })

  it('never takes on more than its ceiling of five', async () => {
    queuedOk()
    const rows = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, email_status: null }))
    const fake = fakeSupabase({
      'prospect_accounts:select': [{ data: rows, error: null }],
      'agent_tasks:select':       [{ data: [], error: null }],
    })
    await applyAction(fake.client, action(), ctx)
    expect(mocks.enqueueTask).toHaveBeenCalledTimes(5)
  })
})
