import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { POST } from '@/app/api/support-inbox/resolve/route'
import { createClient } from '@/lib/supabase/server'

const USER_ID = 'staff_1'

type Resp = { data?: unknown; error?: unknown }

function makeAuthClient(user: { id: string } | null, byTable: Record<string, Resp> = {}) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const result = byTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn((...a: unknown[]) => { calls.push({ table, method: 'select', args: a }); return chain })
    chain.update = vi.fn((...a: unknown[]) => { calls.push({ table, method: 'update', args: a }); return chain })
    chain.eq     = vi.fn((...a: unknown[]) => { calls.push({ table, method: 'eq', args: a }); return chain })
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })

  return {
    auth: { getUser: vi.fn(async () => ({ data: { user } })) },
    from,
    calls,
  }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/support-inbox/resolve', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/support-inbox/resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient(null) as never)

    const res = await POST(postRequest({ conversationId: 'convo_1' }))

    expect(res.status).toBe(401)
  })

  it('rejects a caller with no platform_staff row (non-staff auth model — not org membership)', async () => {
    const client = makeAuthClient({ id: USER_ID }, { platform_staff: { data: null, error: null } })
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_1' }))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json).toEqual({ error: 'Not staff' })
    expect(client.calls.some((c) => c.table === 'support_conversations' && c.method === 'update')).toBe(false)
  })

  it('resolves the conversation on the happy path, marking it closed with needs_human cleared', async () => {
    const client = makeAuthClient(
      { id: USER_ID },
      {
        platform_staff:       { data: { user_id: USER_ID }, error: null },
        support_conversations: { data: null, error: null },
      },
    )
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_1' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ resolved: true })

    const updateCall = client.calls.find((c) => c.table === 'support_conversations' && c.method === 'update')
    expect(updateCall!.args[0]).toEqual(expect.objectContaining({
      needs_human: false,
      status:      'closed',
    }))
    const eqCalls = client.calls.filter((c) => c.table === 'support_conversations' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'convo_1')).toBe(true)
  })

  it('returns a GENERIC error message (not the raw DB error) when the update fails — the raw-error-leak fix applied earlier this session', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = makeAuthClient(
      { id: USER_ID },
      {
        platform_staff:        { data: { user_id: USER_ID }, error: null },
        support_conversations: { data: null, error: { message: 'relation "support_conversations" permission denied for role service_role' } },
      },
    )
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_1' }))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json).toEqual({ error: 'Failed to resolve conversation. Please try again.' })
    expect(json.error).not.toContain('permission denied')
    expect(json.error).not.toContain('service_role')
    expect(consoleErr).toHaveBeenCalled()
    consoleErr.mockRestore()
  })

  it('reaches conversations belonging to any org — cross-tenant access is intentional here (RLS: is_platform_staff() gates read/write across all orgs by design, not scoped per-org like the rest of the schema)', async () => {
    const client = makeAuthClient(
      { id: USER_ID },
      {
        platform_staff:        { data: { user_id: USER_ID }, error: null },
        support_conversations: { data: null, error: null },
      },
    )
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_in_some_other_org' }))

    expect(res.status).toBe(200)
    const eqCalls = client.calls.filter((c) => c.table === 'support_conversations' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'convo_in_some_other_org')).toBe(true)
  })
})
