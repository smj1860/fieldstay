import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireOrgMember = vi.fn()
vi.mock('@/lib/auth', () => ({ requireOrgMember: () => requireOrgMember() }))
vi.mock('@/lib/support/classify', () => ({ classifyIntent: vi.fn() }))
vi.mock('@/lib/support/respond', () => ({ generateResponse: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/rate-limit', () => ({
  supportChatLimiter: {}, supportChatDailyLimiter: {}, checkLimit: vi.fn(),
}))

import { GET } from '@/app/api/support/chat/route'

// ============================================================================
// GET /api/support/chat restores a customer's latest thread. Before it existed
// the widget started empty on every load, so a staff reply sent while the
// customer was away was saved but could never be shown to them.
// ============================================================================

interface Call { table: string; method: string; args: unknown[] }

function makeSupabase(results: Record<string, { data: unknown; error: unknown }>) {
  const calls: Call[] = []
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'order']) {
      chain[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return chain }
    }
    chain.limit = (...args: unknown[]) => {
      calls.push({ table, method: 'limit', args })
      return Promise.resolve(results[table])
    }
    return chain
  })
  return { client: { from }, calls }
}

function signIn(client: unknown) {
  requireOrgMember.mockResolvedValue({
    supabase: client, user: { id: 'user-1' }, membership: { org_id: 'org-1' },
  })
}

describe('GET /api/support/chat', () => {
  beforeEach(() => requireOrgMember.mockReset())

  it('returns an empty thread when the customer has never chatted', async () => {
    const { client } = makeSupabase({ support_conversations: { data: [], error: null } })
    signIn(client)
    const res = await GET()
    expect(await res.json()).toEqual({ conversationId: null, messages: [] })
  })

  it('returns the latest conversation oldest-first with the fields the widget needs', async () => {
    const { client } = makeSupabase({
      support_conversations: { data: [{ id: 'c1' }], error: null },
      // The query is newest-first; the response must be oldest-first.
      support_messages: {
        data: [
          { id: 'm2', role: 'human',     content: 'Welcome!', created_at: '2026-11-10T20:30:00Z' },
          { id: 'm1', role: 'assistant', content: 'Hi',       created_at: '2026-11-10T20:00:00Z' },
        ],
        error: null,
      },
    })
    signIn(client)
    const body = await (await GET()).json()
    expect(body.conversationId).toBe('c1')
    expect(body.messages).toEqual([
      { id: 'm1', role: 'assistant', content: 'Hi',       createdAt: '2026-11-10T20:00:00Z' },
      { id: 'm2', role: 'human',     content: 'Welcome!', createdAt: '2026-11-10T20:30:00Z' },
    ])
  })

  it('drops a message whose role the widget cannot render', async () => {
    const { client } = makeSupabase({
      support_conversations: { data: [{ id: 'c1' }], error: null },
      support_messages: {
        data: [{ id: 'm1', role: 'system', content: 'internal', created_at: '2026-11-10T20:00:00Z' }],
        error: null,
      },
    })
    signIn(client)
    expect((await (await GET()).json()).messages).toEqual([])
  })

  it('scopes the conversation lookup to this user and this org', async () => {
    const { client, calls } = makeSupabase({ support_conversations: { data: [], error: null } })
    signIn(client)
    await GET()
    const eqs = calls.filter((c) => c.table === 'support_conversations' && c.method === 'eq').map((c) => c.args)
    expect(eqs).toContainEqual(['user_id', 'user-1'])
    expect(eqs).toContainEqual(['org_id', 'org-1'])
  })

  it('bounds the message read', async () => {
    const { client, calls } = makeSupabase({
      support_conversations: { data: [{ id: 'c1' }], error: null },
      support_messages: { data: [], error: null },
    })
    signIn(client)
    await GET()
    expect(calls.find((c) => c.table === 'support_messages' && c.method === 'limit')?.args).toEqual([200])
  })

  it('reports a failed read as a 500 instead of an empty thread', async () => {
    const { client } = makeSupabase({
      support_conversations: { data: null, error: { message: 'boom', code: '42501' } },
    })
    signIn(client)
    const res = await GET()
    expect(res.status).toBe(500)
  })

  it('is never cached, since it returns one customer\'s private thread', async () => {
    const { client } = makeSupabase({ support_conversations: { data: [], error: null } })
    signIn(client)
    expect((await GET()).headers.get('Cache-Control')).toBe('no-store')
  })
})
