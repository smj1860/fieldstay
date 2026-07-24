import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  supportChatLimiter:      { limit: vi.fn(async () => ({ success: true })) },
  supportChatDailyLimiter: { limit: vi.fn(async () => ({ success: true })) },
}))
vi.mock('@/lib/support/classify', () => ({
  classifyIntent: vi.fn(),
}))
vi.mock('@/lib/support/respond', () => ({
  generateResponse: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))

import { POST } from '@/app/api/support/chat/route'
import { requireOrgMember } from '@/lib/auth'
import { supportChatLimiter, supportChatDailyLimiter } from '@/lib/rate-limit'
import { classifyIntent } from '@/lib/support/classify'
import { generateResponse } from '@/lib/support/respond'
import { inngest } from '@/lib/inngest/client'

const USER_ID = 'user_1'
const ORG_ID  = 'org_1'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'order', 'limit']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

function mockAuthed(supabase: ReturnType<typeof makeSupabase>) {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: USER_ID } as never,
    supabase:   supabase as never,
    membership: { org_id: ORG_ID, role: 'admin', org: {} as never },
  } as never)
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/support/chat', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

function defaultGenerateResponse() {
  return {
    content: 'Here is how to do that.', modelUsed: 'claude-haiku-4-5-20251001',
    needsEscalation: false, escalationReason: '',
  }
}

describe('POST /api/support/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(supportChatLimiter.limit).mockResolvedValue({ success: true } as never)
    vi.mocked(supportChatDailyLimiter.limit).mockResolvedValue({ success: true } as never)
    vi.mocked(classifyIntent).mockResolvedValue('faq')
    vi.mocked(generateResponse).mockResolvedValue(defaultGenerateResponse())
  })

  it('propagates the redirect when the caller is not an authenticated org member', async () => {
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(POST(postRequest({ message: 'How do I add a property?' }))).rejects.toThrow('REDIRECT:/login')
    expect(supportChatLimiter.limit).not.toHaveBeenCalled()
  })

  it('returns 429 when the per-minute rate limit is exceeded, before the daily check', async () => {
    const supabase = makeSupabase({})
    mockAuthed(supabase)
    vi.mocked(supportChatLimiter.limit).mockResolvedValue({ success: false } as never)

    const res = await POST(postRequest({ message: 'hi' }))

    expect(res.status).toBe(429)
    expect(supportChatDailyLimiter.limit).not.toHaveBeenCalled()
    expect(classifyIntent).not.toHaveBeenCalled()
  })

  it('returns 429 when the daily message cap is exceeded', async () => {
    const supabase = makeSupabase({})
    mockAuthed(supabase)
    vi.mocked(supportChatDailyLimiter.limit).mockResolvedValue({ success: false } as never)

    const res = await POST(postRequest({ message: 'hi' }))

    expect(res.status).toBe(429)
    expect(classifyIntent).not.toHaveBeenCalled()
  })

  it('rejects an empty message', async () => {
    const supabase = makeSupabase({})
    mockAuthed(supabase)

    const res = await POST(postRequest({ message: '   ' }))

    expect(res.status).toBe(400)
    expect(classifyIntent).not.toHaveBeenCalled()
  })

  it('IDOR: returns 404 for a conversationId that does not belong to the caller (different org or different user)', async () => {
    const supabase = makeSupabase({
      support_conversations: [{ data: null, error: null }], // scoped lookup found nothing
    })
    mockAuthed(supabase)

    const res = await POST(postRequest({ message: 'hi', conversationId: 'someone_elses_convo' }))

    expect(res.status).toBe(404)
    const eqCalls = supabase.calls.filter((c) => c.table === 'support_conversations' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'someone_elses_convo')).toBe(true)
    expect(eqCalls.some((c) => c.args[0] === 'user_id' && c.args[1] === USER_ID)).toBe(true)
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(classifyIntent).not.toHaveBeenCalled()
  })

  it('creates a new conversation scoped to the caller\'s org/user when no conversationId is given', async () => {
    const supabase = makeSupabase({
      support_conversations: [{ data: { id: 'convo_new' }, error: null }], // insert().select().single()
      support_messages:      [{ data: [], error: null }],                  // recent-history select
    })
    mockAuthed(supabase)

    const res = await POST(postRequest({ message: 'How do I add a property?' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.conversationId).toBe('convo_new')

    const insertCall = supabase.calls.find((c) => c.table === 'support_conversations' && c.method === 'insert')
    expect(insertCall!.args[0]).toEqual({ org_id: ORG_ID, user_id: USER_ID })
  })

  it('returns 500 when creating a new conversation fails', async () => {
    const supabase = makeSupabase({
      support_conversations: [{ data: null, error: { message: 'insert failed' } }],
    })
    mockAuthed(supabase)

    const res = await POST(postRequest({ message: 'hi' }))

    expect(res.status).toBe(500)
    expect(classifyIntent).not.toHaveBeenCalled()
  })

  it('classifies, generates a response with reversed (chronological) history, persists both turns, and replies', async () => {
    const supabase = makeSupabase({
      support_conversations: [{ data: { id: 'convo_1' }, error: null }], // ownership check
      support_messages: [
        {
          data: [
            { role: 'assistant', content: 'newest reply' },
            { role: 'user', content: 'older question' },
          ],
          error: null,
        },
      ],
    })
    mockAuthed(supabase)
    vi.mocked(classifyIntent).mockResolvedValue('technical')
    vi.mocked(generateResponse).mockResolvedValue({
      content: 'Try refreshing the page.', modelUsed: 'claude-sonnet-4-6',
      needsEscalation: false, escalationReason: '',
    })

    const res = await POST(postRequest({ message: 'Still broken', conversationId: 'convo_1' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({
      conversationId:  'convo_1',
      category:        'technical',
      reply:           'Try refreshing the page.',
      modelUsed:       'claude-sonnet-4-6',
      needsEscalation: false,
    })

    expect(classifyIntent).toHaveBeenCalledWith('Still broken')
    expect(generateResponse).toHaveBeenCalledWith({
      category: 'technical',
      message:  'Still broken',
      // Rows come back newest-first from the DB; the route must reverse them
      // back to chronological order before handing them to the model.
      history: [
        { role: 'user', content: 'older question' },
        { role: 'assistant', content: 'newest reply' },
      ],
      orgId: ORG_ID,
    })

    const userInsert = supabase.calls.find(
      (c) => c.table === 'support_messages' && c.method === 'insert' && (c.args[0] as { role?: string })?.role === 'user',
    )
    expect(userInsert!.args[0]).toEqual(expect.objectContaining({ conversation_id: 'convo_1', content: 'Still broken', category: 'technical' }))

    const assistantInsert = supabase.calls.find(
      (c) => c.table === 'support_messages' && c.method === 'insert' && (c.args[0] as { role?: string })?.role === 'assistant',
    )
    expect(assistantInsert!.args[0]).toEqual(expect.objectContaining({ conversation_id: 'convo_1', content: 'Try refreshing the page.', model_used: 'claude-sonnet-4-6' }))

    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('escalates to a human: updates the conversation (scoped to org_id) and sends the escalation event', async () => {
    const supabase = makeSupabase({
      support_conversations: [{ data: { id: 'convo_1' }, error: null }],
      support_messages:      [{ data: [], error: null }],
    })
    mockAuthed(supabase)
    vi.mocked(classifyIntent).mockResolvedValue('account_specific')
    vi.mocked(generateResponse).mockResolvedValue({
      content: 'This needs a closer look from our team.', modelUsed: 'claude-sonnet-4-6',
      needsEscalation: true, escalationReason: 'guest billing dispute',
    })

    const res = await POST(postRequest({ message: 'I was charged twice', conversationId: 'convo_1' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.needsEscalation).toBe(true)

    const escalationUpdate = supabase.calls.find(
      (c) => c.table === 'support_conversations' && c.method === 'update' && (c.args[0] as { needs_human?: boolean })?.needs_human === true,
    )
    expect(escalationUpdate!.args[0]).toEqual(expect.objectContaining({
      needs_human: true, escalation_reason: 'guest billing dispute',
    }))
    const escalationEq = supabase.calls.filter((c) => c.table === 'support_conversations' && c.method === 'eq')
    expect(escalationEq.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'support/conversation.escalated',
      data: { conversationId: 'convo_1', orgId: ORG_ID, reason: 'guest billing dispute' },
    })
  })
})
