import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { applyApprovedQueue, parseApprovedAccountIds } from '@/lib/gtm/teams/queue-apply'
import { MAX_QUEUE_PROPOSAL, PRE_QUEUE_STATUSES } from '@/lib/gtm/teams/queue-candidates'
import type { AgentTask } from '@/types/database'
import { fakeSupabase, type Scripted } from './fake-supabase'

const ID1 = '5b0a8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'
const ID2 = '6c1b9a8f-2d3e-4f40-9bac-1d2e3f4a5b6c'

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 't1', team: 'lead_gen', task_type: 'queue_candidates', prospect_id: null, status: 'in_progress', priority: 45,
  input: {}, output: { account_ids: [ID1, ID2] }, requires_approval: true, origin: 'rev_ops', parent_task_id: 'r1', depth: 1,
  dedupe_key: null, attempts: 0, max_attempts: 3, error: null, decided_by: 'admin_1', decided_at: '2026-11-19T21:00:00Z',
  decision_note: null, claimed_at: null, completed_at: null, created_at: '2026-11-19T20:00:00Z', updated_at: '2026-11-19T21:00:00Z', ...over,
})

const world = (script: Record<string, Scripted[]> = {}) => fakeSupabase({
  'prospect_accounts:update': [{ data: [{ id: ID1 }, { id: ID2 }], error: null }],
  'prospect_touches:insert':  [{ error: null }],
  ...script,
})

beforeEach(() => { vi.clearAllMocks() })

describe('parseApprovedAccountIds', () => {
  it('keeps valid ids and drops everything else, never fixing it up', () => {
    expect(parseApprovedAccountIds({ account_ids: [ID1, 'nope', 7, null, { x: 1 }, ID2] })).toEqual([ID1, ID2])
  })

  it('removes duplicates and caps the list at the proposal limit', () => {
    expect(parseApprovedAccountIds({ account_ids: [ID1, ID1, ID1] })).toEqual([ID1])
    const many = Array.from({ length: 40 }, (_, i) => `5b0a8f7e-1c2d-4e3f-8a9b-${String(i).padStart(12, '0')}`)
    expect(parseApprovedAccountIds({ account_ids: many })).toHaveLength(MAX_QUEUE_PROPOSAL)
  })

  it.each([null, 'x', 5, [], {}, { account_ids: 'a' }, { account_ids: null }])('returns nothing for a malformed output: %j', (output) => {
    expect(parseApprovedAccountIds(output as never)).toEqual([])
  })
})

describe('applyApprovedQueue', () => {
  // A bug upstream must not be able to turn a proposal nobody approved into a write.
  it('refuses a task with no recorded decision, and writes nothing', async () => {
    const fake = world()
    await expect(applyApprovedQueue(fake.client, task({ decided_at: null }))).rejects.toThrow(/no person approved/)
    expect(fake.calls).toHaveLength(0)
  })

  it('moves the listed accounts to queued and nothing else, in ONE statement', async () => {
    const fake = world()
    expect(await applyApprovedQueue(fake.client, task())).toEqual({ queued: [ID1, ID2], skipped: 0 })

    const updates = fake.calls.filter((c) => c.table === 'prospect_accounts')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ status: 'queued' })
  })

  // A person can move, close or edit an account between approval and application: theirs wins.
  it('carries its own precondition: only a pre-queue stage, only while an email is still there', async () => {
    const fake = world()
    await applyApprovedQueue(fake.client, task())
    const { filters } = fake.calls.find((c) => c.table === 'prospect_accounts')!
    expect(filters).toContainEqual(['in', ['id', [ID1, ID2]]])
    expect(filters).toContainEqual(['in', ['status', [...PRE_QUEUE_STATUSES]]])
    expect(filters).toContainEqual(['not', ['email', 'is', null]])
  })

  it('counts an account that was moved meanwhile as skipped, not queued', async () => {
    const fake = world({ 'prospect_accounts:update': [{ data: [{ id: ID1 }], error: null }] })
    expect(await applyApprovedQueue(fake.client, task())).toEqual({ queued: [ID1], skipped: 1 })
  })

  it('leaves a note per queued account saying a person approved it, never an address', async () => {
    const fake = world()
    await applyApprovedQueue(fake.client, task())
    const notes = fake.calls.find((c) => c.table === 'prospect_touches')!.payload as { prospect_id: string; touch_type: string; note: string; actor_id: string }[]
    expect(notes.map((n) => n.prospect_id)).toEqual([ID1, ID2])
    expect(notes[0]).toMatchObject({ touch_type: 'note', actor_id: 'admin_1', note: 'Moved to queued by Lead Gen (approved).' })
    expect(JSON.stringify(notes)).not.toContain('@')
  })

  it('writes no note when nothing was queued', async () => {
    const fake = world({ 'prospect_accounts:update': [{ data: [], error: null }] })
    expect(await applyApprovedQueue(fake.client, task())).toEqual({ queued: [], skipped: 2 })
    expect(fake.calls.some((c) => c.table === 'prospect_touches')).toBe(false)
  })

  it('keeps the stage change even if the history note cannot be written', async () => {
    const fake = world({ 'prospect_touches:insert': [{ error: { message: 'boom' } }] })
    expect(await applyApprovedQueue(fake.client, task())).toEqual({ queued: [ID1, ID2], skipped: 0 })
  })

  it('writes nothing for a proposal with no valid accounts', async () => {
    const fake = world()
    expect(await applyApprovedQueue(fake.client, task({ output: { account_ids: ['nope'] } }))).toMatchObject({ queued: [], reason: 'no_valid_accounts' })
    expect(fake.calls).toHaveLength(0)
  })

  it('throws on a database error so the task retries, rather than reporting success', async () => {
    const fake = world({ 'prospect_accounts:update': [{ data: null, error: { message: 'boom' } }] })
    await expect(applyApprovedQueue(fake.client, task())).rejects.toBeDefined()
  })
})
