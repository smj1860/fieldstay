import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

// The market list ships empty, so a test that needs one swaps it in here.
const markets = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('@/lib/gtm/teams/queue-candidates', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/gtm/teams/queue-candidates')>()
  const mocked = { ...actual }
  Object.defineProperty(mocked, 'LOW_COVERAGE_MARKETS', { get: () => markets.list, enumerable: true })
  return mocked
})

import { QUEUE_TASK_TYPE, queueCandidatesHandler } from '@/lib/gtm/teams/lead-gen-queue'
import { leadGenHandlers } from '@/lib/gtm/teams/lead-gen'
import { QUEUE_POOL_TARGET } from '@/lib/gtm/teams/queue-candidates'
import { executableTypes } from '@/lib/gtm/worker'
import type { AgentTask } from '@/types/database'
import { fakeSupabase } from './fake-supabase'

const NOW = new Date('2026-11-19T21:00:00Z')
const run = queueCandidatesHandler.run

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 'q1', team: 'lead_gen', task_type: 'queue_candidates', prospect_id: null, status: 'in_progress', priority: 45,
  input: {}, output: null, requires_approval: true, origin: 'rev_ops', parent_task_id: 'r1', depth: 1, dedupe_key: null,
  attempts: 0, max_attempts: 3, error: null, decided_by: null, decided_at: null, decision_note: null, claimed_at: null,
  completed_at: null, created_at: '2026-11-19T20:00:00Z', updated_at: '2026-11-19T20:00:00Z', ...over,
})

const row = (over: Record<string, unknown> = {}) => ({
  id: '5b0a8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', company: 'Acme Rentals', city: 'Dadeville', state: 'AL', pms: 'OwnerRez', market: null,
  portfolio_size: 20, contact_name: 'Dana Smith', email: 'dana@acmerentals.com', email_is_generic: false, email_status: 'unknown', status: 'new', ...over,
})

function world(over: { queued?: number; ownerRez?: unknown[]; lowCoverage?: unknown[] } = {}) {
  return fakeSupabase({
    'prospect_accounts:select': [
      { count: over.queued ?? 0, error: null },
      { data: over.ownerRez ?? [row()], error: null },
      { data: over.lowCoverage ?? [], error: null },
    ],
  })
}
const ctxOf = (fake: ReturnType<typeof world>) => ({ supabase: fake.client, setting: {} as never, now: NOW })

beforeEach(() => {
  vi.clearAllMocks()
  markets.list = []
})

describe('queue_candidates: the registry', () => {
  it('is registered with Lead Gen and has an execute step (applying what a person approved)', () => {
    expect(leadGenHandlers[QUEUE_TASK_TYPE]).toBe(queueCandidatesHandler)
    expect(executableTypes(leadGenHandlers)).toContain(QUEUE_TASK_TYPE)
  })
})

describe('queue_candidates: proposing', () => {
  it('proposes the OwnerRez accounts it finds, with who, where and why, and no email address', async () => {
    const out = await run(task(), ctxOf(world()))
    expect(out.kind).toBe('propose')
    const o = out.output as { account_ids: string[]; body: string; subject: string; summary: string }
    expect(o.account_ids).toEqual(['5b0a8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'])
    expect(o.body).toContain('1. Acme Rentals (Dadeville, AL): runs OwnerRez')
    expect(JSON.stringify(out)).not.toContain('@')
    expect(o.subject).toBe('Queue 1 account for outreach')
  })

  it('applies the OwnerRez criterion in the database, bounded, so it is not lost behind older rows', async () => {
    const fake = world()
    await run(task(), ctxOf(fake))
    const read = fake.calls.filter((c) => c.table === 'prospect_accounts' && c.filters.some(([f]) => f === 'ilike'))
    expect(read).toHaveLength(1)
    expect(read[0].filters).toContainEqual(['ilike', ['pms', 'OwnerRez']])
    expect(read[0].filters).toContainEqual(['in', ['status', ['new', 'researching', 'needs_contact_info']]])
    expect(read[0].filters).toContainEqual(['eq', ['email_is_generic', false]])
    expect(read[0].filters.some(([f]) => f === 'limit')).toBe(true)
  })

  it('skips the market read entirely while the list is empty, so only OwnerRez can match', async () => {
    const fake = world()
    await run(task(), ctxOf(fake))
    expect(fake.calls.filter((c) => c.filters.some(([f, a]) => f === 'in' && a[0] === 'market'))).toHaveLength(0)
  })

  it('reads and proposes accounts in a listed market once the founder names one', async () => {
    markets.list = ['Smoky Mountains']
    const smoky = row({ id: '6c1b9a8f-2d3e-4f40-9bac-1d2e3f4a5b6c', company: 'Cabin Co', pms: 'Guesty', market: 'Smoky Mountains' })
    const fake = fakeSupabase({
      'prospect_accounts:select': [{ count: 0, error: null }, { data: [], error: null }, { data: [smoky], error: null }],
    })
    const out = await run(task(), { supabase: fake.client, setting: {} as never, now: NOW })
    expect(out.kind).toBe('propose')
    expect((out.output as { body: string }).body).toContain('in Smoky Mountains, on your low-coverage list')
    expect(fake.calls.some((c) => c.filters.some(([f, a]) => f === 'in' && a[0] === 'market'))).toBe(true)
  })

  it('lists an account that matches both criteria once', async () => {
    markets.list = ['Smoky Mountains']
    const both = row({ market: 'Smoky Mountains' })
    const fake = fakeSupabase({
      'prospect_accounts:select': [{ count: 0, error: null }, { data: [both], error: null }, { data: [both], error: null }],
    })
    const out = await run(task(), { supabase: fake.client, setting: {} as never, now: NOW })
    expect((out.output as { account_ids: string[] }).account_ids).toHaveLength(1)
  })

  it('re-checks every rule on what it read: a role inbox, a bounced email or a wrong size never gets through', async () => {
    const bad = [
      row({ id: 'g', email_is_generic: true }), row({ id: 'b', email_status: 'bounced' }),
      row({ id: 's', portfolio_size: 200_000 }), row({ id: 'n', email_is_generic: null }), row({ id: 'q', status: 'queued' }),
    ]
    const out = await run(task(), ctxOf(world({ ownerRez: bad })))
    expect(out).toMatchObject({ kind: 'nothing', output: { reason: 'no_candidates' } })
  })

  it('says why there is nothing, including that the market list is empty', async () => {
    const out = await run(task(), ctxOf(world({ ownerRez: [] })))
    expect(out).toMatchObject({ kind: 'nothing', output: { reason: 'no_candidates' } })
    expect(String((out.output as { summary: string }).summary)).toContain('The low-coverage market list is empty')
  })

  it(`proposes nothing once ${QUEUE_POOL_TARGET} accounts are already queued`, async () => {
    const fake = world({ queued: QUEUE_POOL_TARGET })
    expect(await run(task(), ctxOf(fake))).toMatchObject({ kind: 'nothing', output: { reason: 'pool_full' } })
    expect(fake.calls.filter((c) => c.filters.some(([f]) => f === 'ilike'))).toHaveLength(0)
  })

  it('caps one proposal at ten accounts, best first', async () => {
    const many = Array.from({ length: 25 }, (_, i) => row({
      id: `5b0a8f7e-1c2d-4e3f-8a9b-${String(i).padStart(12, '0')}`, company: `Co ${String(i).padStart(2, '0')}`, contact_name: i < 3 ? 'Named' : null,
    }))
    const out = await run(task(), ctxOf(world({ ownerRez: many })))
    const ids = (out.output as { account_ids: string[] }).account_ids
    expect(ids).toHaveLength(10)
    expect(ids.slice(0, 3)).toEqual(many.slice(0, 3).map((r) => r.id))
  })

  it('spends no model money', async () => {
    const fake = world()
    await run(task(), ctxOf(fake))
    expect(fake.calls.some((c) => c.table === 'agent_usage')).toBe(false)
  })
})

describe('queue_candidates: applying', () => {
  it('refuses to apply a proposal no person decided on', async () => {
    const fake = fakeSupabase({})
    await expect(queueCandidatesHandler.execute(task({ output: { account_ids: [] } }), { supabase: fake.client, setting: {} as never, now: NOW }))
      .rejects.toThrow(/no person approved/)
  })
})
