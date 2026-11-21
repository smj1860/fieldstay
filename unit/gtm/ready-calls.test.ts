import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { MAX_READY_CALLS, loadReadyCalls } from '@/lib/gtm/dashboard'
import { fakeSupabase } from './fake-supabase'

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', decided_at: '2026-11-19T12:00:00Z',
  output: { subject: 'Call brief: Acme Rentals', body: 'What we know' },
  prospect_accounts: { company: 'Acme Rentals', contact_name: 'Dana Smith', phone: '256-555-0100' }, ...over,
})

describe('loadReadyCalls', () => {
  it('reads approved Sales Ops call briefs, oldest approval first and bounded', async () => {
    const fake = fakeSupabase({ 'agent_tasks:select': [{ data: [row()], error: null }] })
    expect(await loadReadyCalls(fake.client)).toEqual([{
      id: 'c1', company: 'Acme Rentals', contactName: 'Dana Smith', phone: '256-555-0100',
      headline: 'Call brief: Acme Rentals', brief: 'What we know', approvedAt: '2026-11-19T12:00:00Z',
    }])
    const filters = fake.calls[0].filters
    expect(filters).toContainEqual(['eq', ['task_type', 'call_brief']])
    expect(filters).toContainEqual(['eq', ['status', 'approved']])
    expect(filters).toContainEqual(['order', ['decided_at', { ascending: true }]])
    expect(filters).toContainEqual(['limit', [MAX_READY_CALLS]])
  })

  it('accepts the account embedded as an array, and tolerates a missing phone', async () => {
    const fake = fakeSupabase({ 'agent_tasks:select': [{ data: [row({ prospect_accounts: [{ company: 'Acme', contact_name: null, phone: null }] })], error: null }] })
    expect((await loadReadyCalls(fake.client))[0]).toMatchObject({ company: 'Acme', contactName: null, phone: null })
  })

  it.each([null, 'x', [], { subject: 'only a subject' }])('skips an approved task whose output is not a brief: %j', async (output) => {
    const fake = fakeSupabase({ 'agent_tasks:select': [{ data: [row({ output })], error: null }] })
    expect(await loadReadyCalls(fake.client)).toEqual([])
  })

  it('throws on a query error rather than showing an empty list', async () => {
    const fake = fakeSupabase({ 'agent_tasks:select': [{ data: null, error: { message: 'boom' } }] })
    await expect(loadReadyCalls(fake.client)).rejects.toThrow()
  })
})
