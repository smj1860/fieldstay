import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
const researchSite = vi.hoisted(() => vi.fn())
vi.mock('@/lib/gtm/teams/lead-gen-fetch', () => ({ researchSite }))

import { enrichAccountHandler, siteUrlFor } from '@/lib/gtm/teams/lead-gen'
import type { AgentTask } from '@/types/database'
import { fakeSupabase } from './fake-supabase'

const handler = enrichAccountHandler
const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 't1', team: 'lead_gen', task_type: 'enrich_account', prospect_id: 'p1', status: 'in_progress', priority: 40,
  input: {}, output: null, requires_approval: true, origin: 'rev_ops', parent_task_id: 'r1', depth: 1, dedupe_key: null,
  attempts: 0, max_attempts: 3, error: null, decided_by: null, decided_at: null, decision_note: null, claimed_at: null,
  completed_at: null, created_at: '2026-11-18T12:00:00Z', updated_at: '2026-11-18T12:00:00Z', ...over,
})
const prospectRow = (over: Record<string, unknown> = {}) =>
  ({ id: 'p1', company: 'Acme Rentals', website: 'https://acmerentals.com', domain: 'acmerentals.com', email: null, phone: null, ...over })
const ctxFor = (row: unknown) => ({ supabase: fakeSupabase({ 'prospect_accounts:select': [{ data: row, error: null }] }).client, setting: {} as never, now: new Date() })

beforeEach(() => { vi.clearAllMocks() })

describe('siteUrlFor', () => {
  it('prefers the website, falls back to the domain, and only ever returns https', () => {
    expect(siteUrlFor({ website: 'https://acmerentals.com', domain: 'other.com' })).toBe('https://acmerentals.com')
    expect(siteUrlFor({ website: null, domain: 'acmerentals.com' })).toBe('https://acmerentals.com')
    expect(siteUrlFor({ website: 'http://acmerentals.com', domain: null })).toBeNull()
    expect(siteUrlFor({ website: null, domain: null })).toBeNull()
  })

  it('refuses a value that is not a usable web address', () => {
    expect(siteUrlFor({ website: 'javascript:alert(1)', domain: null })).toBeNull()
    expect(siteUrlFor({ website: 'mailto:a@b.com', domain: null })).toBeNull()
  })
})

describe('enrich_account: run', () => {
  it('closes as nothing-to-propose, reading no website, for each case that has no work', async () => {
    const cases: [string, unknown, Partial<AgentTask>][] = [
      ['account_not_found', null, {}],
      ['already_has_contact', prospectRow({ email: 'a@b.com', phone: '+15550001111' }), {}],
      ['no_website', prospectRow({ website: null, domain: null }), {}],
      ['no_account', null, { prospect_id: null }],
    ]
    for (const [reason, row, over] of cases) {
      const out = await handler.run(task(over), ctxFor(row))
      expect(out).toMatchObject({ kind: 'nothing', output: { reason } })
    }
    expect(researchSite).not.toHaveBeenCalled()
  })

  it('reads the site and turns what it found into a proposal', async () => {
    researchSite.mockResolvedValue({ robotsBlocked: false, pages: [{
      url: 'https://acmerentals.com/',
      findings: { emails: [{ email: 'dana@acmerentals.com', how: 'mailto', sourceUrl: 'https://acmerentals.com/' }], phones: [], contactLinks: [] },
    }] })
    const out = await handler.run(task(), ctxFor(prospectRow()))
    expect(researchSite).toHaveBeenCalledWith('https://acmerentals.com')
    expect(out).toMatchObject({ kind: 'propose', output: { fields: { email: 'dana@acmerentals.com' } } })
  })

  it('lets a failed read propagate so the worker retries it', async () => {
    researchSite.mockRejectedValue(new Error('Site unavailable'))
    await expect(handler.run(task(), ctxFor(prospectRow()))).rejects.toThrow('Site unavailable')
  })

  it('throws on a database error rather than reporting a missing account', async () => {
    const ctx = { supabase: fakeSupabase({ 'prospect_accounts:select': [{ data: null, error: { message: 'denied' } }] }).client, setting: {} as never, now: new Date() }
    await expect(handler.run(task(), ctx)).rejects.toMatchObject({ message: 'denied' })
  })
})

describe('enrich_account: execute', () => {
  it('refuses to apply anything for a task no person approved', async () => {
    await expect(handler.execute(task({ decided_at: null }), ctxFor(null))).rejects.toThrow('no person approved')
  })
})
