import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { POST } from '@/app/api/support-inbox/reply/route'
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
    chain.insert = vi.fn((...a: unknown[]) => { calls.push({ table, method: 'insert', args: a }); return Promise.resolve(result) })
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
  return new NextRequest('http://localhost/api/support-inbox/reply', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/support-inbox/reply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient(null) as never)

    const res = await POST(postRequest({ conversationId: 'convo_1', content: 'hi' }))

    expect(res.status).toBe(401)
  })

  it('rejects a caller with no platform_staff row (non-staff auth model — not org membership)', async () => {
    const client = makeAuthClient({ id: USER_ID }, { platform_staff: { data: null, error: null } })
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_1', content: 'hi' }))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json).toEqual({ error: 'Not staff' })
    expect(client.calls.some((c) => c.table === 'support_messages' && c.method === 'insert')).toBe(false)
  })

  it('rejects empty/whitespace-only content before inserting', async () => {
    const client = makeAuthClient({ id: USER_ID }, { platform_staff: { data: { user_id: USER_ID }, error: null } })
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_1', content: '   ' }))

    expect(res.status).toBe(400)
    expect(client.calls.some((c) => c.table === 'support_messages' && c.method === 'insert')).toBe(false)
  })

  it('inserts the staff reply as a human message scoped to the authenticated staff member, and assigns the conversation to them', async () => {
    const client = makeAuthClient(
      { id: USER_ID },
      {
        platform_staff:      { data: { user_id: USER_ID }, error: null },
        support_messages:    { data: null, error: null },
      },
    )
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_1', content: '  We\'re looking into this.  ' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ sent: true })

    const insertCall = client.calls.find((c) => c.table === 'support_messages' && c.method === 'insert')
    expect(insertCall!.args[0]).toEqual({
      conversation_id: 'convo_1',
      role:            'human',
      content:         "We're looking into this.",
      sent_by_user_id: USER_ID,
    })

    const updateCall = client.calls.find((c) => c.table === 'support_conversations' && c.method === 'update')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((updateCall!.args[0] as any).assigned_staff_id).toBe(USER_ID)
    const convoEq = client.calls.filter((c) => c.table === 'support_conversations' && c.method === 'eq')
    expect(convoEq.some((c) => c.args[0] === 'id' && c.args[1] === 'convo_1')).toBe(true)
  })

  it('returns 500 without inserting the conversation-state update when the message insert itself fails', async () => {
    const client = makeAuthClient(
      { id: USER_ID },
      {
        platform_staff:   { data: { user_id: USER_ID }, error: null },
        support_messages: { data: null, error: { message: 'insert failed' } },
      },
    )
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_1', content: 'hi' }))

    expect(res.status).toBe(500)
    expect(client.calls.some((c) => c.table === 'support_conversations' && c.method === 'update')).toBe(false)

    const body = await res.clone().json()
    expect(body.error).not.toContain('insert failed')
    expect(body.error).toBe('Failed to send reply. Please try again.')
  })

  it('reaches conversations belonging to any org — cross-tenant access is intentional here (RLS: is_platform_staff() gates read/write across all orgs by design, not scoped per-org like the rest of the schema)', async () => {
    const client = makeAuthClient(
      { id: USER_ID },
      {
        platform_staff:   { data: { user_id: USER_ID }, error: null },
        support_messages: { data: null, error: null },
      },
    )
    vi.mocked(createClient).mockResolvedValue(client as never)

    const res = await POST(postRequest({ conversationId: 'convo_in_some_other_org', content: 'hi' }))

    expect(res.status).toBe(200)
    const insertCall = client.calls.find((c) => c.table === 'support_messages' && c.method === 'insert')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((insertCall!.args[0] as any).conversation_id).toBe('convo_in_some_other_org')
  })
})
