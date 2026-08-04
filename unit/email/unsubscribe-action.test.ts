import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { recordUnsubscribe } from '@/app/unsubscribe/[token]/actions'
import { createServiceClient } from '@/lib/supabase/server'

const VALID = 'a'.repeat(64)

type Resp = { data?: unknown; error?: unknown }

/** Queue of responses per table, consumed in order. */
function makeSupabase(queue: Resp[]) {
  const calls: { method: string; args: unknown[] }[] = []
  let i = 0
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'update', 'eq', 'is']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ method: m, args })
        return chain
      })
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(queue[i++] ?? { data: null, error: null }))
    return chain
  })
  return { from, calls }
}

function mockDb(queue: Resp[]) {
  const supabase = makeSupabase(queue)
  vi.mocked(createServiceClient).mockReturnValue(supabase as never)
  return supabase
}

describe('recordUnsubscribe', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records the opt-out for a valid token', async () => {
    const supabase = mockDb([{ data: { id: 'user_1' }, error: null }])

    await expect(recordUnsubscribe(VALID)).resolves.toEqual({ ok: true })

    const update = supabase.calls.find((c) => c.method === 'update')
    expect(update?.args[0]).toMatchObject({ email_unsubscribed_at: expect.any(String) })
    // Scoped by the token itself — the token IS the credential here.
    expect(supabase.calls.some((c) =>
      c.method === 'eq' && c.args[0] === 'unsubscribe_token' && c.args[1] === VALID,
    )).toBe(true)
  })

  it('is idempotent — an already-unsubscribed token still succeeds', async () => {
    // The UPDATE matches 0 rows (filtered by .is(email_unsubscribed_at, null)),
    // then the existence probe finds the profile. A mail client doing an
    // RFC 8058 one-click POST may retry, and a retry must not read as failure.
    mockDb([{ data: null, error: null }, { data: { id: 'user_1' }, error: null }])

    await expect(recordUnsubscribe(VALID)).resolves.toEqual({ ok: true })
  })

  it('reports an unknown token as invalid rather than a successful opt-out', async () => {
    // 0 rows updated AND no such profile. Collapsing this into success would
    // report an opt-out that never happened.
    mockDb([{ data: null, error: null }, { data: null, error: null }])

    const result = await recordUnsubscribe(VALID)
    expect(result).toEqual({ ok: false, error: 'This unsubscribe link is not valid.' })
  })

  it.each([
    ['a uuid',           '3f7c1b2e-1111-2222-3333-444455556666'],
    ['too short',        'abc'],
    ['uppercase hex',    'A'.repeat(64)],
    ['empty',            ''],
  ])('rejects a malformed token (%s) without querying', async (_label, token) => {
    const supabase = mockDb([])

    const result = await recordUnsubscribe(token)
    expect(result).toEqual({ ok: false, error: 'This unsubscribe link is not valid.' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('surfaces a query error instead of claiming the opt-out succeeded', async () => {
    mockDb([{ data: null, error: { message: 'db down' } }])

    const result = await recordUnsubscribe(VALID)
    expect(result).toEqual({ ok: false, error: 'Something went wrong. Please try again.' })
  })
})
