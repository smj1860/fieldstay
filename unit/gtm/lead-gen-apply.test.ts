import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { reportError } from '@/lib/observability/report-error'
import { applyApprovedContacts, parseApprovedContacts } from '@/lib/gtm/teams/lead-gen-apply'
import type { AgentTask } from '@/types/database'
import { fakeSupabase } from './fake-supabase'

// ============================================================================
// The one place a GTM agent writes the prospect tables. Everything that keeps
// that safe is asserted here: no decision, no write; only empty fields; only
// email and phone; and a person's own value always wins.
// ============================================================================

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 't1', team: 'lead_gen', task_type: 'enrich_account', prospect_id: 'p1', status: 'in_progress', priority: 40,
  input: {}, output: { fields: { email: 'Dana@AcmeRentals.com', phone: '(865) 555-0142' } }, requires_approval: true,
  origin: 'rev_ops', parent_task_id: null, depth: 1, dedupe_key: null, attempts: 0, max_attempts: 3, error: null,
  decided_by: 'admin_1', decided_at: '2026-11-18T12:00:00Z', decision_note: null, claimed_at: '2026-11-18T12:01:00Z',
  completed_at: null, created_at: '2026-11-18T11:00:00Z', updated_at: '2026-11-18T12:01:00Z', ...over,
})

beforeEach(() => { vi.clearAllMocks() })

describe('applyApprovedContacts', () => {
  it('fills empty email and phone, normalised, and leaves a note saying a person approved it', async () => {
    const { client, calls } = fakeSupabase({
      'prospect_accounts:update': [{ data: { id: 'p1' }, error: null }],
      'prospect_touches:insert': [{ error: null }],
    })
    expect(await applyApprovedContacts(client, task())).toEqual({ applied: ['email', 'phone'], skipped: [] })

    const writes = calls.filter((c) => c.table === 'prospect_accounts')
    expect(writes.map((c) => c.payload)).toEqual([{ email: 'dana@acmerentals.com' }, { phone: '+18655550142' }])
    const note = calls.find((c) => c.table === 'prospect_touches')!.payload as Record<string, unknown>
    expect(note).toMatchObject({ prospect_id: 'p1', touch_type: 'note', actor_id: 'admin_1' })
    expect(String(note.note)).toContain('approved')
  })

  // A person can fill the field between approval and application. Theirs wins,
  // and the guard is the UPDATE's own IS NULL, not a read before it.
  it('only writes a field that is still empty, and reports the one that was filled meanwhile', async () => {
    const { client, calls } = fakeSupabase({
      'prospect_accounts:update': [{ data: null, error: null }, { data: { id: 'p1' }, error: null }],
      'prospect_touches:insert': [{ error: null }],
    })
    const out = await applyApprovedContacts(client, task())
    expect(out).toEqual({ applied: ['phone'], skipped: [{ field: 'email', reason: 'already_filled' }] })
    const writes = calls.filter((c) => c.table === 'prospect_accounts')
    expect(writes[0].filters).toContainEqual(['is', ['email', null]])
    expect(writes[1].filters).toContainEqual(['is', ['phone', null]])
  })

  it('writes no history note when nothing was applied', async () => {
    const { client, calls } = fakeSupabase({ 'prospect_accounts:update': [{ data: null, error: null }] })
    expect(await applyApprovedContacts(client, task())).toMatchObject({ applied: [] })
    expect(calls.some((c) => c.table === 'prospect_touches')).toBe(false)
  })

  it('refuses a task no person approved, and touches nothing', async () => {
    const { client, calls } = fakeSupabase({})
    await expect(applyApprovedContacts(client, task({ decided_at: null }))).rejects.toThrow('no person approved')
    expect(calls).toHaveLength(0)
  })

  it('names no account, writes nothing', async () => {
    const { client, calls } = fakeSupabase({})
    expect(await applyApprovedContacts(client, task({ prospect_id: null }))).toEqual({ applied: [], skipped: [{ field: 'all', reason: 'no_account' }] })
    expect(calls).toHaveLength(0)
  })

  it('never writes a column other than email and phone', async () => {
    const { client, calls } = fakeSupabase({
      'prospect_accounts:update': [{ data: { id: 'p1' }, error: null }],
      'prospect_touches:insert': [{ error: null }],
    })
    await applyApprovedContacts(client, task({ output: { fields: { email: 'a@acmerentals.com', status: 'won', notes: 'x', score_a: 99 } } }))
    for (const c of calls.filter((x) => x.table === 'prospect_accounts')) {
      expect(Object.keys(c.payload as object)).toEqual(['email'])
    }
  })

  it('throws, and reports, on a database error rather than claiming success', async () => {
    const { client } = fakeSupabase({ 'prospect_accounts:update': [{ data: null, error: { code: '42501', message: 'denied' } }] })
    await expect(applyApprovedContacts(client, task())).rejects.toMatchObject({ code: '42501' })
    expect(reportError).toHaveBeenCalled()
  })

  it('keeps the saved contact when only the history note fails', async () => {
    const { client } = fakeSupabase({
      'prospect_accounts:update': [{ data: { id: 'p1' }, error: null }],
      'prospect_touches:insert': [{ error: { message: 'boom' } }],
    })
    await expect(applyApprovedContacts(client, task())).resolves.toMatchObject({ applied: ['email', 'phone'] })
    expect(reportError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ level: 'warning' }))
  })

  it('never puts the contact value in the history note', async () => {
    const { client, calls } = fakeSupabase({
      'prospect_accounts:update': [{ data: { id: 'p1' }, error: null }],
      'prospect_touches:insert': [{ error: null }],
    })
    await applyApprovedContacts(client, task())
    const note = String((calls.find((c) => c.table === 'prospect_touches')!.payload as { note: string }).note)
    expect(note).not.toMatch(/@|\+1|555/)
  })
})

describe('parseApprovedContacts', () => {
  it('re-validates the stored proposal and drops anything that does not parse', () => {
    expect(parseApprovedContacts({ fields: { email: 'not an email', phone: '12' } })).toEqual({})
    expect(parseApprovedContacts({ fields: { email: 'A@B.com', phone: '865-555-0142' } })).toEqual({ email: 'a@b.com', phone: '+18655550142' })
  })

  it.each([null, 'x', 7, [], { fields: null }, { fields: [] }, { fields: { email: 5, phone: {} } }])('reads %j as nothing to apply', (bad) => {
    expect(parseApprovedContacts(bad as never)).toEqual({})
  })
})
