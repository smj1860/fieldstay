import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { CALL_BRIEF_TASK_TYPE, callBriefHandler, factsFrom } from '@/lib/gtm/teams/sales-ops-calls'
import { salesOpsHandlers } from '@/lib/gtm/teams/sales-ops'
import { executableTypes } from '@/lib/gtm/worker'
import type { AgentTask } from '@/types/database'
import { fakeSupabase } from './fake-supabase'

const NOW = new Date('2026-11-19T20:00:00Z')
const run = callBriefHandler.run

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 't1', team: 'sales_ops', task_type: 'call_brief', prospect_id: 'p1', status: 'in_progress', priority: 60,
  input: {}, output: null, requires_approval: true, origin: 'human', parent_task_id: null, depth: 0, dedupe_key: null,
  attempts: 0, max_attempts: 3, error: null, decided_by: null, decided_at: null, decision_note: null, claimed_at: null,
  completed_at: null, created_at: '2026-11-19T12:00:00Z', updated_at: '2026-11-19T12:00:00Z', ...over,
})
const prospect = (over: Record<string, unknown> = {}) => ({
  id: 'p1', company: 'Acme Rentals', city: 'Dadeville', state: 'AL', market: null, pms: 'OwnerRez', pms_note: null,
  portfolio_size: 30, contact_name: 'Dana Smith', contact_title: 'Owner', email_is_generic: false, phone: '256-555-0100',
  source: 'import', status: 'emailed', notes: null, status_note: null, ...over,
})

function world(over: { prospect?: unknown; touches?: unknown[] } = {}) {
  return fakeSupabase({
    'prospect_accounts:select': [{ data: over.prospect === undefined ? prospect() : over.prospect, error: null }],
    'prospect_touches:select':  [{ data: over.touches ?? [{ touch_type: 'emailed', occurred_at: '2026-11-13T20:00:00Z' }], error: null }],
  })
}
const ctxOf = (fake: ReturnType<typeof world>) => ({ supabase: fake.client, setting: {} as never, now: NOW })

beforeEach(() => { vi.clearAllMocks() })

describe('call_brief: the registry', () => {
  it('is registered with Sales Ops', () => {
    expect(salesOpsHandlers[CALL_BRIEF_TASK_TYPE]).toBe(callBriefHandler)
  })

  // The last step is a person on their own phone. A worker must never claim an approved brief.
  it('has no execute step, so a worker never takes an approved brief', () => {
    expect(callBriefHandler.execute).toBeUndefined()
    expect(executableTypes(salesOpsHandlers)).not.toContain(CALL_BRIEF_TASK_TYPE)
  })
})

describe('call_brief: who gets one', () => {
  it.each(['won', 'lost', 'disqualified'])('prepares nothing for a closed account (%s)', async (status) => {
    const fake = world({ prospect: prospect({ status }) })
    expect(await run(task(), ctxOf(fake))).toMatchObject({ kind: 'nothing', output: { reason: 'closed' } })
  })

  // An account that replied is exactly who a person is about to call.
  it.each(['new', 'queued', 'emailed', 'replied', 'meeting_set', 'in_trial'])('prepares one for an account at %s', async (status) => {
    expect((await run(task(), ctxOf(world({ prospect: prospect({ status }) })))).kind).toBe('propose')
  })

  it('reports a missing account and a task that names none', async () => {
    expect(await run(task(), ctxOf(world({ prospect: null })))).toMatchObject({ kind: 'nothing', output: { reason: 'account_not_found' } })
    expect(await run(task({ prospect_id: null }), ctxOf(world()))).toMatchObject({ kind: 'nothing', output: { reason: 'no_account' } })
  })
})

describe('call_brief: the proposal', () => {
  it('uses subject and body so the inbox and panels render it, and spends no model money', async () => {
    const fake = world()
    const out = await run(task(), ctxOf(fake))
    expect(out.kind).toBe('propose')
    expect(out.output).toMatchObject({ subject: 'Call brief: Acme Rentals', has_phone: true })
    expect(String((out.output as { body: string }).body)).toContain('Guesses to ask about')
    expect(fake.calls.some((c) => c.table === 'agent_usage')).toBe(false)
  })

  it('keeps the phone number and email out of the stored output', async () => {
    const out = await run(task(), ctxOf(world()))
    expect(JSON.stringify(out)).not.toContain('256-555-0100')
    expect(JSON.stringify(out)).not.toContain('@')
  })

  it('turns recent touches into ages, and joins the founder\'s notes', async () => {
    const fake = world({ prospect: prospect({ notes: 'met at the expo', status_note: 'likes email' }) })
    const out = await run(task(), ctxOf(fake))
    const body = String((out.output as { body: string }).body)
    expect(body).toContain('emailed 6 days ago')
    expect(body).toContain('met at the expo / likes email')
  })
})

describe('factsFrom', () => {
  it('treats a blank phone as no phone', () => {
    expect(factsFrom(prospect({ phone: '  ' }) as never, []).hasPhone).toBe(false)
    expect(factsFrom(prospect({ phone: null }) as never, []).hasPhone).toBe(false)
  })
})
