import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
const generateDraft = vi.hoisted(() => vi.fn())
vi.mock('@/lib/gtm/teams/sales-ops-draft', () => ({ generateDraft, SALES_DRAFT_MODEL: 'claude-sonnet-5-5' }))

import { MAX_DRAFT_ATTEMPTS, buildBrief, draftOutreachHandler, firstNameOf, salesOpsHandlers } from '@/lib/gtm/teams/sales-ops'
import { executableTypes } from '@/lib/gtm/worker'
import { revOpsHandlers } from '@/lib/gtm/teams/rev-ops'
import { leadGenHandlers } from '@/lib/gtm/teams/lead-gen'
import { VOICE_GUIDE_VERSION } from '@/lib/gtm/brand/voice'
import type { AgentTask } from '@/types/database'
import { fakeSupabase, type Scripted } from './fake-supabase'

const NOW = new Date('2026-11-18T20:00:00Z')
const run = draftOutreachHandler.run

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 't1', team: 'sales_ops', task_type: 'draft_outreach', prospect_id: 'p1', status: 'in_progress', priority: 50,
  input: {}, output: null, requires_approval: true, origin: 'rev_ops', parent_task_id: 'r1', depth: 1, dedupe_key: null,
  attempts: 0, max_attempts: 3, error: null, decided_by: null, decided_at: null, decision_note: null, claimed_at: null,
  completed_at: null, created_at: '2026-11-18T12:00:00Z', updated_at: '2026-11-18T12:00:00Z', ...over,
})
const prospect = (over: Record<string, unknown> = {}) => ({
  id: 'p1', company: 'Acme Rentals', city: 'Dadeville', state: 'AL', pms: 'OwnerRez', portfolio_size: 30,
  contact_name: 'Dana Smith', contact_title: 'Owner', status: 'emailed', email: 'dana@acmerentals.com',
  email_status: 'unknown', last_touch_at: '2026-11-04T20:00:00Z', ...over,
})

const GOOD = {
  subject: 'Turnovers on Lake Martin',
  body: 'Hi Dana, running thirty cabins on Lake Martin means a lot of Friday turnovers. FieldStay creates each turnover from the booking, suggests who should take it, and lets the crew work from a phone checklist even with no signal. Setting up a property takes about 15 minutes. Would it help if I showed you how it works on one of your cabins? If this is not useful, tell me and I will stop.',
}
const call = (draft: { subject: string; body: string } | null) => ({ model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 200, draft })

function world(over: { prospect?: unknown; touches?: unknown[]; feedback?: unknown[]; usage?: Scripted[] } = {}) {
  return fakeSupabase({
    'prospect_accounts:select': [{ data: over.prospect === undefined ? prospect() : over.prospect, error: null }],
    'prospect_touches:select':  [{ data: over.touches ?? [{ touch_type: 'emailed', occurred_at: '2026-11-04T20:00:00Z' }], error: null }],
    'agent_tasks:select':       [{ data: over.feedback ?? [], error: null }],
    'agent_usage:insert':       over.usage ?? [{ error: null }],
  })
}
const ctxOf = (fake: ReturnType<typeof world>) => ({ supabase: fake.client, setting: {} as never, now: NOW })

beforeEach(() => { vi.clearAllMocks() })

describe('draft_outreach: who gets a draft', () => {
  it.each([
    ['closed', { status: 'won' }],
    ['in_conversation', { status: 'replied' }],
    ['not_ready', { status: 'new' }],
    ['no_email', { email: null }],
    ['email_bounced', { email_status: 'bounced' }],
  ])('writes no draft and spends nothing when the account is %s', async (reason, over) => {
    const fake = world({ prospect: prospect(over) })
    expect(await run(task(), ctxOf(fake))).toMatchObject({ kind: 'nothing', output: { reason } })
    expect(generateDraft).not.toHaveBeenCalled()
    expect(fake.calls.some((c) => c.table === 'agent_usage')).toBe(false)
  })

  it('reports a missing account and a task that names none, without a model call', async () => {
    expect(await run(task(), ctxOf(world({ prospect: null })))).toMatchObject({ kind: 'nothing', output: { reason: 'account_not_found' } })
    expect(await run(task({ prospect_id: null }), ctxOf(world()))).toMatchObject({ kind: 'nothing', output: { reason: 'no_account' } })
    expect(generateDraft).not.toHaveBeenCalled()
  })
})

describe('draft_outreach: writing the draft', () => {
  it('proposes a draft that passed the voice check, and says so, without the email address', async () => {
    generateDraft.mockResolvedValue(call(GOOD))
    const out = await run(task(), ctxOf(world()))

    expect(out.kind).toBe('propose')
    expect(out.output).toMatchObject({ subject: GOOD.subject, body: GOOD.body, voice_check: { passed: true, version: VOICE_GUIDE_VERSION, attempts: 1 }, kind: 'follow_up' })
    expect(String((out.output as { summary: string }).summary)).toContain('Voice check passed')
    expect(JSON.stringify(out)).not.toContain('dana@acmerentals.com')
  })

  it('bills every call, keyed so a retried step bills once', async () => {
    generateDraft.mockResolvedValue(call(GOOD))
    const fake = world()
    await run(task({ attempts: 2 }), ctxOf(fake))
    expect(fake.calls.find((c) => c.table === 'agent_usage')!.payload).toMatchObject({
      team: 'sales_ops', task_id: 't1', model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200, dedupe_key: 'sales_ops:draft:t1:2:0',
    })
  })

  // The money is spent whether or not the draft is any good.
  it('asks once more, with exactly what broke, when the first draft fails the voice check, and bills both', async () => {
    generateDraft.mockResolvedValueOnce(call({ ...GOOD, body: GOOD.body.replace('Friday turnovers.', 'Friday turnovers — every week.') })).mockResolvedValueOnce(call(GOOD))
    const fake = world({ usage: [{ error: null }] })
    const out = await run(task(), ctxOf(fake))

    expect(generateDraft).toHaveBeenCalledTimes(2)
    expect(generateDraft.mock.calls[1][1]).toEqual([expect.objectContaining({ rule: 'em_dash' })])
    expect(out.output).toMatchObject({ voice_check: { attempts: 2 } })
    const keys = fake.calls.filter((c) => c.table === 'agent_usage').map((c) => (c.payload as { dedupe_key: string }).dedupe_key)
    expect(keys).toEqual(['sales_ops:draft:t1:0:0', 'sales_ops:draft:t1:0:1'])
  })

  it('treats a reply with no draft as a miss and tries again', async () => {
    generateDraft.mockResolvedValueOnce(call(null)).mockResolvedValueOnce(call(GOOD))
    expect((await run(task(), ctxOf(world()))).kind).toBe('propose')
    expect(generateDraft).toHaveBeenCalledTimes(2)
  })

  // A rule is never quietly waived: a draft that cannot pass is a visible failure.
  it('fails the task, naming the rules, when it cannot pass in two tries', async () => {
    generateDraft.mockResolvedValue(call({ subject: 'FREE!', body: 'Hi Dana, act now! It is $19.' }))
    const fake = world()
    await expect(run(task(), ctxOf(fake))).rejects.toThrow(/voice check after 2 tries: .*pricing/)
    expect(generateDraft).toHaveBeenCalledTimes(MAX_DRAFT_ATTEMPTS)
    expect(fake.calls.filter((c) => c.table === 'agent_usage')).toHaveLength(MAX_DRAFT_ATTEMPTS)
  })

  it('lets a failed model call propagate so the task retries, and bills nothing for it', async () => {
    generateDraft.mockRejectedValue(new Error('overloaded'))
    const fake = world()
    await expect(run(task(), ctxOf(fake))).rejects.toThrow('overloaded')
    expect(fake.calls.some((c) => c.table === 'agent_usage')).toBe(false)
  })

  it('refuses a draft that greets the wrong person', async () => {
    generateDraft.mockResolvedValue(call({ ...GOOD, body: GOOD.body.replace('Hi Dana,', 'Hi Sam,') }))
    await expect(run(task(), ctxOf(world()))).rejects.toThrow(/greeting/)
  })

  it('greets "Hi there," when the account has no usable first name', async () => {
    generateDraft.mockResolvedValue(call({ ...GOOD, body: GOOD.body.replace('Hi Dana,', 'Hi there,') }))
    const out = await run(task(), ctxOf(world({ prospect: prospect({ contact_name: null }) })))
    expect(out.kind).toBe('propose')
    expect(generateDraft.mock.calls[0][0].contactFirstName).toBeNull()
  })
})

describe('draft_outreach: what the model is given', () => {
  it('passes the founder\'s rejection notes, and never the email address or phone', async () => {
    generateDraft.mockResolvedValue(call(GOOD))
    await run(task(), ctxOf(world({ feedback: [{ decision_note: 'too salesy' }, { decision_note: '  ' }, { decision_note: null }] })))
    const given = generateDraft.mock.calls[0][0]
    expect(given.feedback).toEqual(['too salesy'])
    expect(JSON.stringify(given)).not.toMatch(/@acmerentals|dana@|\+1/)
  })

  it('reads only a few recent touches, as types and ages', async () => {
    generateDraft.mockResolvedValue(call(GOOD))
    await run(task(), ctxOf(world()))
    expect(generateDraft.mock.calls[0][0].priorTouches).toEqual([{ type: 'emailed', daysAgo: 14 }])
  })
})

describe('buildBrief / firstNameOf', () => {
  const row = prospect() as Parameters<typeof buildBrief>[0]

  it('calls it a first touch only for a queued account nothing has gone out to', () => {
    expect(buildBrief({ ...row, status: 'queued' }, [], [], NOW).kind).toBe('first_touch')
    expect(buildBrief({ ...row, status: 'queued' }, [{ type: 'emailed', daysAgo: 3 }], [], NOW).kind).toBe('follow_up')
    expect(buildBrief({ ...row, status: 'emailed' }, [], [], NOW).kind).toBe('follow_up')
  })

  it('counts days since the last touch', () => {
    expect(buildBrief(row, [], [], NOW).daysSinceLastTouch).toBe(14)
    expect(buildBrief({ ...row, last_touch_at: null }, [], [], NOW).daysSinceLastTouch).toBeNull()
  })

  it.each([
    ['Dana Smith', 'Dana'], ['  dana  ', 'dana'], ['Dr. Smith', null], ['J. Smith', null], ['J', null], ['', null], [null, null],
  ])('reads the first name of %j as %j', (name, expected) => {
    expect(firstNameOf(name)).toBe(expected)
  })
})

describe('Sales Ops never has a worker finish its drafts', () => {
  it('has no execute step, so a worker has nothing to do with an approved draft', () => {
    expect(draftOutreachHandler.execute).toBeUndefined()
    expect(executableTypes(salesOpsHandlers)).toEqual([])
  })

  it('leaves the other teams\' execute steps alone', () => {
    expect(executableTypes(revOpsHandlers)).toEqual(['weekly_funnel_report'])
    expect(executableTypes(leadGenHandlers)).toEqual(['enrich_account', 'queue_candidates'])
  })
})
