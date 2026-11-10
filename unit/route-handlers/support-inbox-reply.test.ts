import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { POST } from '@/app/api/support-inbox/reply/route'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'

const USER_ID = 'staff_1'

type Resp = { data?: unknown; error?: unknown }

function makeAuthClient(user: { id: string } | null, byTable: Record<string, Resp> = {}) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const result = byTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn((...a: unknown[]) => { calls.push({ table, method: 'select', args: a }); return chain })
    // Returns the chain, not a bare promise: the route reads the new row's id
    // back with .select('id').single(). The chain is still awaitable via then().
    chain.insert = vi.fn((...a: unknown[]) => { calls.push({ table, method: 'insert', args: a }); return chain })
    chain.single = vi.fn(() => Promise.resolve(result))
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

  // A staff reply is saved and shows live in the customer's chat if it is open.
  // A customer who is logged out never sees that push, so the saved reply also
  // queues an email. Queuing is best effort: a reply that is already stored
  // must not be reported as failed because the email could not be queued.
  describe('notifying the customer', () => {
    const savedReply = () => makeAuthClient(
      { id: USER_ID },
      {
        platform_staff:   { data: { user_id: USER_ID }, error: null },
        support_messages: { data: { id: 'msg_1' }, error: null },
      },
    )

    it('queues one email event per saved reply, keyed on the message id', async () => {
      vi.mocked(createClient).mockResolvedValue(savedReply() as never)

      const res = await POST(postRequest({ conversationId: 'convo_1', content: 'Welcome!' }))

      expect(res.status).toBe(200)
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'support/staff-reply.sent',
        id:   'support-staff-reply-msg_1',
        data: { conversationId: 'convo_1', messageId: 'msg_1' },
      })
    })

    it('still reports the reply as sent when queuing the email fails, and reports it as a warning', async () => {
      vi.mocked(createClient).mockResolvedValue(savedReply() as never)
      vi.mocked(inngest.send).mockRejectedValueOnce(new Error('inngest down'))

      const res = await POST(postRequest({ conversationId: 'convo_1', content: 'Welcome!' }))

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: true })
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ level: 'warning' }))
    })

    it('queues nothing when the reply was not saved', async () => {
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
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })
})
