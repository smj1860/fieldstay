import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { POST } from '@/app/api/dashboard/push-subscribe/route'
import { createClient } from '@/lib/supabase/server'

const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function makeSupabase(opts: {
  user?: { id: string } | null
  membership?: { org_id: string } | null
  upsertError?: unknown
}) {
  const upsertMock = vi.fn(() => Promise.resolve({ error: opts.upsertError ?? null }))

  const from = vi.fn((table: string) => {
    if (table === 'organization_members') {
      const chain: Record<string, unknown> = {}
      chain.select = vi.fn(() => chain)
      chain.eq     = vi.fn(() => chain)
      chain.single = vi.fn(() => Promise.resolve({ data: opts.membership ?? null, error: null }))
      return chain
    }
    if (table === 'push_subscriptions') {
      return { upsert: upsertMock }
    }
    throw new Error(`Unexpected table: ${table}`)
  })

  return {
    from,
    upsertMock,
    auth: {
      getUser: vi.fn(() => Promise.resolve({ data: { user: opts.user ?? null } })),
    },
  }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/dashboard/push-subscribe', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/dashboard/push-subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an unauthenticated caller before touching push_subscriptions', async () => {
    const supabase = makeSupabase({ user: null })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest({ endpoint: 'https://push.example/e1', p256dh: 'k', auth: 'a' }))

    expect(res.status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalledWith('push_subscriptions')
  })

  it('rejects a caller with no organization_members row', async () => {
    const supabase = makeSupabase({ user: { id: USER_ID }, membership: null })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest({ endpoint: 'https://push.example/e1', p256dh: 'k', auth: 'a' }))

    expect(res.status).toBe(403)
    expect(supabase.from).not.toHaveBeenCalledWith('push_subscriptions')
  })

  it('rejects a body missing endpoint/p256dh/auth without touching the DB', async () => {
    const supabase = makeSupabase({ user: { id: USER_ID }, membership: { org_id: ORG_ID } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest({ endpoint: 'https://push.example/e1' }))

    expect(res.status).toBe(400)
    expect(supabase.upsertMock).not.toHaveBeenCalled()
  })

  it('rejects an unparseable body without touching the DB', async () => {
    const supabase = makeSupabase({ user: { id: USER_ID }, membership: { org_id: ORG_ID } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const req = new NextRequest('http://localhost/api/dashboard/push-subscribe', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    'not-json',
    })
    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(supabase.upsertMock).not.toHaveBeenCalled()
  })

  it('upserts the subscription scoped to the authenticated user/org — user_id/org_id are server-derived, not client-supplied', async () => {
    const supabase = makeSupabase({ user: { id: USER_ID }, membership: { org_id: ORG_ID } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(
      postRequest({
        endpoint: 'https://push.example/e1',
        p256dh:   'key-p256dh',
        auth:     'key-auth',
        // Attempted override — must be ignored, the route builds the upsert
        // object explicitly from the authenticated session.
        user_id: 'attacker_user',
        org_id:  'attacker_org',
      }),
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })
    expect(supabase.from).toHaveBeenCalledWith('push_subscriptions')
    expect(supabase.upsertMock).toHaveBeenCalledWith(
      {
        user_id:  USER_ID,
        org_id:   ORG_ID,
        endpoint: 'https://push.example/e1',
        p256dh:   'key-p256dh',
        auth:     'key-auth',
      },
      { onConflict: 'user_id,endpoint' },
    )
  })

  it('returns 500 when the upsert fails', async () => {
    const supabase = makeSupabase({
      user:        { id: USER_ID },
      membership:  { org_id: ORG_ID },
      upsertError: { message: 'db is down' },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest({ endpoint: 'https://push.example/e1', p256dh: 'k', auth: 'a' }))

    expect(res.status).toBe(500)
  })
})
