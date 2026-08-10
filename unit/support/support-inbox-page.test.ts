import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/app/(dashboard)/support-inbox/support-inbox-client', () => ({
  SupportInboxClient: () => null,
}))

import SupportInboxPage from '@/app/(dashboard)/support-inbox/page'
import { createClient } from '@/lib/supabase/server'

// ============================================================================
// Escalations are fetched separately from recent conversations.
//
// One capped query ordered `needs_human` first does keep escalations at the
// top — so the audit's "any needs_human conversation past the top 100 becomes
// permanently invisible" overstates it; that needs 100 simultaneous OPEN
// escalations, not 100 conversations. But at that point the overflow is silent,
// and being seen is the one thing this page exists to guarantee.
// ============================================================================

interface Call { table: string; method: string; args: unknown[] }

function makeSupabase(rows: Record<string, unknown[]>) {
  const calls: Call[] = []
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    let bucket = table
    const record = (method: string, args: unknown[]) => {
      calls.push({ table: bucket, method, args })
      // The two support_conversations reads are told apart by their eq filter,
      // which is exactly how the page distinguishes them.
      if (table === 'support_conversations' && method === 'eq' && args[0] === 'needs_human') {
        bucket = args[1] === true ? 'escalated' : 'recent'
      }
      return chain
    }
    for (const m of ['select', 'eq', 'order', 'limit']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    chain.maybeSingle = () => Promise.resolve({ data: { user_id: 'staff_1' }, error: null })
    chain.single      = () => Promise.resolve({ data: { user_id: 'staff_1' }, error: null })
    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows[bucket] ?? [], error: null }).then(res)
    return chain
  })

  return {
    from,
    calls,
    auth: { getUser: async () => ({ data: { user: { id: 'staff_1' } } }) },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('support-inbox page', () => {
  it('queries escalations and recent conversations as two separate bounded reads', async () => {
    const supabase = makeSupabase({
      escalated: [{ id: 'c_esc', needs_human: true }],
      recent:    [{ id: 'c_recent', needs_human: false }],
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    await SupportInboxPage()

    const escalated = supabase.calls.filter((c) => c.table === 'escalated')
    const recent    = supabase.calls.filter((c) => c.table === 'recent')

    expect(escalated.length, 'an escalations-only read must exist').toBeGreaterThan(0)
    expect(recent.length,    'a recent-only read must exist').toBeGreaterThan(0)

    // Escalations get their own, much higher ceiling — they must never compete
    // with resolved chatter for slots.
    const escLimit    = escalated.find((c) => c.method === 'limit')!.args[0] as number
    const recentLimit = recent.find((c) => c.method === 'limit')!.args[0] as number
    expect(escLimit).toBeGreaterThan(recentLimit)
  })

  it('orders escalations by escalated_at, so the oldest unanswered is not the one that falls off', async () => {
    const supabase = makeSupabase({ escalated: [], recent: [] })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    await SupportInboxPage()

    const escOrders = supabase.calls
      .filter((c) => c.table === 'escalated' && c.method === 'order')
      .map((c) => c.args[0])
    expect(escOrders).toContain('escalated_at')
  })
})
