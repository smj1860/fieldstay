import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/gtm/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gtm/tasks')>()),
  enqueueTask: vi.fn(),
}))

import { enqueueTask } from '@/lib/gtm/tasks'
import { loadReportInput, weeklyReportHandler } from '@/lib/gtm/teams/rev-ops'
import type { AgentTask } from '@/types/database'
import { fakeSupabase } from './fake-supabase'

const NOW = new Date('2026-11-16T13:00:00Z')
const DAY = 86_400_000
const period = (days: number) => Math.floor(NOW.getTime() / (days * DAY))
const handler = weeklyReportHandler

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 'report-1', team: 'rev_ops', task_type: 'weekly_funnel_report', prospect_id: null, status: 'in_progress', priority: 50,
  input: {}, output: { handoff: { lead_gen_enrich: ['a', 'b', 'c'] } }, requires_approval: true, origin: 'rev_ops',
  parent_task_id: null, depth: 0, dedupe_key: null, attempts: 0, max_attempts: 3, error: null, decided_by: 'admin_1',
  decided_at: '2026-11-16T14:00:00Z', decision_note: null, claimed_at: null, completed_at: null,
  created_at: '2026-11-16T13:00:00Z', updated_at: '2026-11-16T14:00:00Z', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  // Approving a report always also asks Lead Gen for a queue proposal, so every handoff makes one extra call.
  vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
})

describe('approving a Rev Ops report', () => {
  const ctx = () => ({ supabase: fakeSupabase({}).client, setting: {} as never, now: NOW })

  it('hands each account to Lead Gen as its own task, one level deeper, naming the report as the parent', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
    const { output } = await handler.execute(task(), ctx())

    expect(enqueueTask).toHaveBeenCalledTimes(4)
    expect(vi.mocked(enqueueTask).mock.calls[0][1]).toMatchObject({
      team: 'lead_gen', taskType: 'enrich_account', origin: 'rev_ops', prospectId: 'a',
      parent: { id: 'report-1', depth: 0 }, dedupeKey: `lead_gen:enrich_account:a:${period(30)}`,
    })
    expect(output).toEqual({ handoff: { requested: 3, queued: 3 }, sales_ops_handoff: { requested: 0, queued: 0 }, queue_handoff: { queued: 1 } })
  })

  // Lead Gen being off or already asked about an account is an ordinary answer, never a failure.
  it('records why an account was not queued instead of failing the report', async () => {
    vi.mocked(enqueueTask)
      .mockResolvedValueOnce({ ok: true, id: 'x' })
      .mockResolvedValueOnce({ ok: false, reason: 'duplicate' })
      .mockResolvedValueOnce({ ok: false, reason: 'team_off' })
    const { output } = await handler.execute(task(), ctx())
    expect(output).toEqual({ handoff: { requested: 3, queued: 1, duplicate: 1, team_off: 1 }, sales_ops_handoff: { requested: 0, queued: 0 }, queue_handoff: { queued: 1 } })
  })

  it('queues Lead Gen work that still needs approval', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
    await handler.execute(task(), ctx())
    // requiresApproval is left to its default of true: it is never passed as false.
    expect(vi.mocked(enqueueTask).mock.calls.every((c) => c[1].requiresApproval !== false)).toBe(true)
  })

  it('caps the handoff even if the stored report somehow lists more', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
    const many = Array.from({ length: 50 }, (_, i) => `id${i}`)
    await handler.execute(task({ output: { handoff: { lead_gen_enrich: many } } }), ctx())
    // Ten accounts, plus the one queue proposal.
    expect(enqueueTask).toHaveBeenCalledTimes(11)
  })

  it('ignores anything in the stored output that is not an account id', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
    await handler.execute(task({ output: { handoff: { lead_gen_enrich: ['ok', 7, null, { x: 1 }] } } }), ctx())
    expect(enqueueTask).toHaveBeenCalledTimes(2)
  })

  it.each([null, 'x', [], { handoff: null }, { handoff: { lead_gen_enrich: 'a' } }])('queues nothing for a malformed output: %j', async (output) => {
    const res = await handler.execute(task({ output: output as never }), ctx())
    // No accounts to hand off, but the queue proposal is still requested.
    expect(vi.mocked(enqueueTask).mock.calls.map((c) => c[1].taskType)).toEqual(['queue_candidates'])
    expect(res.output).toEqual({ handoff: { requested: 0, queued: 0 }, sales_ops_handoff: { requested: 0, queued: 0 }, queue_handoff: { queued: 1 } })
  })
})

describe('approving a Rev Ops report: the Sales Ops handoff', () => {
  const ctx = () => ({ supabase: fakeSupabase({}).client, setting: {} as never, now: NOW })
  const withDrafts = (ids: string[]) => task({ output: { handoff: { lead_gen_enrich: [], sales_ops_draft: ids } } })

  it('queues a draft task per account for Sales Ops, with its own cap, priority and dedupe period', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
    const { output } = await handler.execute(withDrafts(['d1', 'd2']), ctx())

    expect(enqueueTask).toHaveBeenCalledTimes(3)
    expect(vi.mocked(enqueueTask).mock.calls[0][1]).toMatchObject({
      team: 'sales_ops', taskType: 'draft_outreach', origin: 'rev_ops', prospectId: 'd1',
      parent: { id: 'report-1', depth: 0 }, priority: 50, dedupeKey: `sales_ops:draft_outreach:d1:${period(14)}`,
    })
    expect(output).toMatchObject({ sales_ops_handoff: { requested: 2, queued: 2 } })
  })

  it('caps the drafts even if the stored report lists more', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
    await handler.execute(withDrafts(Array.from({ length: 40 }, (_, i) => `d${i}`)), ctx())
    expect(enqueueTask).toHaveBeenCalledTimes(6)
  })

  it('records a team that is off or an account already drafted for without failing', async () => {
    vi.mocked(enqueueTask).mockResolvedValueOnce({ ok: false, reason: 'team_off' }).mockResolvedValueOnce({ ok: false, reason: 'duplicate' })
    const { output } = await handler.execute(withDrafts(['d1', 'd2']), ctx())
    expect(output).toMatchObject({ sales_ops_handoff: { requested: 2, queued: 0, team_off: 1, duplicate: 1 } })
  })

  it('treats a report written before Sales Ops existed as having no drafts to hand off', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
    const { output } = await handler.execute(task({ output: { handoff: { lead_gen_enrich: ['a'] } } }), ctx())
    expect(enqueueTask).toHaveBeenCalledTimes(2)
    expect(output).toMatchObject({ sales_ops_handoff: { requested: 0, queued: 0 } })
  })

  it('queues for Lead Gen and Sales Ops from the same approval, each to its own team', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'x' })
    await handler.execute(task({ output: { handoff: { lead_gen_enrich: ['a'], sales_ops_draft: ['d1'] } } }), ctx())
    expect(vi.mocked(enqueueTask).mock.calls.map((c) => c[1].team)).toEqual(['lead_gen', 'sales_ops', 'lead_gen'])
  })
})

describe('approving a Rev Ops report: the queue proposal', () => {
  const ctx = () => ({ supabase: fakeSupabase({}).client, setting: {} as never, now: NOW })

  it('asks Lead Gen for ONE proposal, as a child of the report, once per week', async () => {
    await handler.execute(task({ output: { handoff: {} } }), ctx())
    const calls = vi.mocked(enqueueTask).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toMatchObject({
      team: 'lead_gen', taskType: 'queue_candidates', origin: 'rev_ops', parent: { id: 'report-1', depth: 0 },
      dedupeKey: `lead_gen:queue_candidates:${period(7)}`,
    })
    expect(calls[0][1]).not.toHaveProperty('prospectId')
    expect(calls[0][1].requiresApproval).not.toBe(false)
  })

  it.each(['duplicate', 'team_off', 'task_cap'] as const)('records %s as an ordinary answer, never a failure', async (reason) => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: false, reason })
    const { output } = await handler.execute(task({ output: { handoff: {} } }), ctx())
    expect(output).toMatchObject({ queue_handoff: { [reason]: 1 } })
  })
})

describe('loadReportInput', () => {
  it('assembles the report from the rollup and the account counts, and drops accounts Lead Gen already looked at', async () => {
    const { client } = fakeSupabase({
      'prospect_accounts:select': [
        { count: 14, error: null },                                                            // stale count
        { data: [{ company: 'Acme', status: 'emailed', last_touch_at: '2026-10-26T13:00:00Z' }], error: null }, // stale examples
        { count: 120, error: null }, { count: 6, error: null }, { count: 9, error: null },     // hygiene
        { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], error: null },                        // enrich candidate pool
        { data: [{ id: 'd1' }, { id: 'd2' }], error: null },                                   // draft candidate pool
      ],
      'agent_tasks:select': [
        { data: [{ prospect_id: 'b' }], error: null },                                         // Lead Gen already looked at b
        { data: [{ prospect_id: 'd2' }], error: null },                                        // Sales Ops already drafted d2
      ],
    }, [
      { data: { funnel: { new: 5 }, touches: { emailed: 10 }, tasks: [], spend: [{ team: 'manager', cost_cents: 2, calls: 1 }] } },
      { data: { funnel: { new: 5 }, touches: { emailed: 25 }, tasks: [], spend: [] } },
    ])

    const input = await loadReportInput(client, NOW)
    expect(input.staleCount).toBe(14)
    expect(input.staleExamples).toEqual([{ company: 'Acme', status: 'emailed', daysSinceTouch: 21 }])
    expect([input.needsContactInfo, input.bouncedPrimary, input.queuedNoChannel]).toEqual([120, 6, 9])
    expect(input.enrichCandidates).toEqual(['a', 'c'])
    expect(input.draftCandidates).toEqual(['d1'])
    expect(input.touchesThisWeek).toEqual({ emailed: 10 })
    expect(input.touchesPriorWeek).toEqual({ emailed: 15 })
    expect(input.spendTodayCents).toBe(2)
  })

  it('fails loudly if the rollup cannot be read, instead of reporting zeros as fact', async () => {
    const { client } = fakeSupabase({
      'prospect_accounts:select': [{ count: 0, error: null }],
      'agent_tasks:select': [{ data: [], error: null }],
    }, [{ error: { message: 'permission denied' } }])
    await expect(loadReportInput(client, NOW)).rejects.toThrow('rollup failed')
  })

  it('offers no candidates when none qualify, without asking about tasks', async () => {
    const { client, calls } = fakeSupabase({
      'prospect_accounts:select': [{ count: 0, error: null }, { data: [], error: null }, { count: 0, error: null }, { count: 0, error: null }, { count: 0, error: null }, { data: [], error: null }, { data: [], error: null }],
    }, [{ data: {} }, { data: {} }])
    const input = await loadReportInput(client, NOW)
    expect(input.enrichCandidates).toEqual([])
    expect(input.draftCandidates).toEqual([])
    expect(calls.some((c) => c.table === 'agent_tasks')).toBe(false)
  })
})
