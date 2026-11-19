import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { DRAFT_QUALITY_WINDOW_DAYS, MAX_QUALITY_NOTES, MAX_READY_DRAFTS, loadDraftReadiness } from '@/lib/gtm/dashboard'
import { fakeSupabase, type Scripted } from './fake-supabase'

const NOW = new Date('2026-11-18T20:00:00Z')

// The five reads run together, so they resolve in the order they were issued:
// ready drafts, approved, sent, rejected, then the rejection notes.
function load(script: { ready?: Scripted; approved?: number; sent?: number; rejected?: number; notes?: Scripted }) {
  const fake = fakeSupabase({
    'agent_tasks:select': [
      script.ready ?? { data: [], error: null },
      { count: script.approved ?? 0, error: null },
      { count: script.sent ?? 0, error: null },
      { count: script.rejected ?? 0, error: null },
      script.notes ?? { data: [], error: null },
    ],
  })
  return { ...fake, result: loadDraftReadiness(fake.client, NOW) }
}

const approved = (over: Record<string, unknown> = {}) => ({
  id: 't1', decided_at: '2026-11-17T12:00:00Z',
  output: { subject: 'Hello', body: 'Hi Dana, text' },
  prospect_accounts: { company: 'Acme Rentals', email: 'dana@acmerentals.com', contact_name: 'Dana Smith' }, ...over,
})

describe('loadDraftReadiness: drafts ready to send', () => {
  it('reads an approved draft with its recipient, oldest approval first', async () => {
    const { result, calls } = load({ ready: { data: [approved()], error: null } })
    expect((await result).readyDrafts).toEqual([{
      id: 't1', company: 'Acme Rentals', contactName: 'Dana Smith', email: 'dana@acmerentals.com',
      subject: 'Hello', body: 'Hi Dana, text', approvedAt: '2026-11-17T12:00:00Z',
    }])
    const q = calls.find((c) => c.filters.some(([f, a]) => f === 'eq' && a[0] === 'status' && a[1] === 'approved'))!
    expect(q.filters).toContainEqual(['order', ['decided_at', { ascending: true }]])
    expect(q.filters).toContainEqual(['limit', [MAX_READY_DRAFTS]])
  })

  it('accepts the account embedded as an object or as a one-element array', async () => {
    const { result } = load({ ready: { data: [approved({ prospect_accounts: [{ company: 'Acme', email: null, contact_name: null }] })], error: null } })
    expect((await result).readyDrafts[0]).toMatchObject({ company: 'Acme', email: null, contactName: null })
  })

  // A row that is not a draft cannot be shown as one, and must not crash the page.
  it.each([null, 'x', [], { subject: 'only a subject' }, { body: 5, subject: 's' }])('skips an approved task whose output is not a draft: %j', async (output) => {
    const { result } = load({ ready: { data: [approved({ output })], error: null } })
    expect((await result).readyDrafts).toEqual([])
  })
})

describe('loadDraftReadiness: draft quality', () => {
  it('counts approved, sent and rejected drafts decided in the window', async () => {
    const { result, calls } = load({ approved: 12, sent: 9, rejected: 3 })
    expect((await result).draftQuality).toMatchObject({ approved: 12, sent: 9, rejected: 3 })

    const since = new Date(NOW.getTime() - DRAFT_QUALITY_WINDOW_DAYS * 86_400_000).toISOString()
    const counted = calls.filter((c) => c.filters.some(([f, a]) => f === 'gte' && a[0] === 'decided_at'))
    expect(counted).toHaveLength(3)
    for (const c of counted) expect(c.filters).toContainEqual(['gte', ['decided_at', since]])
  })

  it('counts "approved" as approved-or-since-sent, so a sent draft is still an approved one', async () => {
    const { calls, result } = load({})
    await result
    expect(calls.some((c) => c.filters.some(([f, a]) => f === 'in' && a[0] === 'status' && JSON.stringify(a[1]) === '["approved","done"]'))).toBe(true)
  })

  it('returns the founder\'s rejection notes, newest first and capped, dropping rows without text', async () => {
    const { result, calls } = load({ notes: { data: [
      { decision_note: 'too salesy', decided_at: '2026-11-17T00:00:00Z' },
      { decision_note: null, decided_at: '2026-11-16T00:00:00Z' },
      { decision_note: 'no pricing', decided_at: null },
    ], error: null } })
    expect((await result).draftQuality.notes).toEqual([{ note: 'too salesy', decidedAt: '2026-11-17T00:00:00Z' }])
    const q = calls.find((c) => c.filters.some(([f, a]) => f === 'limit' && a[0] === MAX_QUALITY_NOTES))!
    expect(q.filters).toContainEqual(['order', ['decided_at', { ascending: false }]])
  })

  it('reports an empty record as zeros, not as an error', async () => {
    const { result } = load({})
    expect((await result).draftQuality).toEqual({ approved: 0, rejected: 0, sent: 0, notes: [] })
  })

  it('throws, rather than showing zeros, when a read fails', async () => {
    const { result } = load({ approved: 0, notes: { data: null, error: { message: 'permission denied' } } })
    await expect(result).rejects.toThrow()
  })
})
