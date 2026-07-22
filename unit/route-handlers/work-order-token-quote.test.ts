import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  workOrderRatelimit: { limit: vi.fn(async () => ({ success: true })) },
}))
vi.mock('@/lib/integrations/webhook-verification', () => ({
  extractClientIp: vi.fn(() => '203.0.113.5'),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))

import { GET, POST } from '@/app/api/work-orders/[token]/quote/route'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit } from '@/lib/rate-limit'
import { inngest } from '@/lib/inngest/client'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq']) {
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

const VALID_TOKEN = 'wo-quote-token-1234567890'

function getRequest(token: string) {
  return new NextRequest(`http://localhost/api/work-orders/${token}/quote`)
}

function postRequest(token: string, body: unknown) {
  return new NextRequest(`http://localhost/api/work-orders/${token}/quote`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

function callGet(token: string) {
  return GET(getRequest(token), { params: Promise.resolve({ token }) })
}

function callPost(token: string, body: unknown) {
  return POST(postRequest(token, body), { params: Promise.resolve({ token }) })
}

function baseQuoteRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id:                     'qr_1',
    org_id:                 'org_1',
    work_order_id:          'wo_1',
    status:                 'pending',
    quote_token_expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('GET /api/work-orders/[token]/quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: true } as never)
  })

  it('returns 429 and never touches the DB when the IP rate limit is exceeded', async () => {
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: false } as never)

    const res = await callGet(VALID_TOKEN)

    expect(res.status).toBe(429)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 404 for an invalid/nonexistent token', async () => {
    const supabase = makeSupabase({ quote_requests: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callGet(VALID_TOKEN)

    expect(res.status).toBe(404)
  })

  it('returns 410 for an expired quote token', async () => {
    const supabase = makeSupabase({
      quote_requests: [{
        data: {
          ...baseQuoteRequest({ quote_token_expires_at: '2020-01-01T00:00:00.000Z' }),
          work_orders: { id: 'wo_1', title: 'Fix sink', properties: { name: 'Lakeview Cabin' } },
        },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callGet(VALID_TOKEN)

    expect(res.status).toBe(410)
  })

  it('returns the quote request and work order for a valid, unexpired token', async () => {
    const supabase = makeSupabase({
      quote_requests: [{
        data: {
          ...baseQuoteRequest(),
          work_orders: { id: 'wo_1', title: 'Fix sink', properties: { name: 'Lakeview Cabin' } },
        },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callGet(VALID_TOKEN)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.quoteRequest.id).toBe('qr_1')
    expect(json.workOrder.id).toBe('wo_1')
  })
})

describe('POST /api/work-orders/[token]/quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: true } as never)
  })

  it('returns 429 and never touches the DB when the IP rate limit is exceeded', async () => {
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: false } as never)

    const res = await callPost(VALID_TOKEN, { amount: 500 })

    expect(res.status).toBe(429)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 404 for an invalid/nonexistent token before any mutation', async () => {
    const supabase = makeSupabase({ quote_requests: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { amount: 500 })

    expect(res.status).toBe(404)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('rejects when the quote request is no longer pending', async () => {
    const supabase = makeSupabase({ quote_requests: [{ data: baseQuoteRequest({ status: 'submitted' }), error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { amount: 500 })

    expect(res.status).toBe(409)
  })

  it('expires the quote request and rejects when the token has expired', async () => {
    const supabase = makeSupabase({
      quote_requests: [{ data: baseQuoteRequest({ quote_token_expires_at: '2020-01-01T00:00:00.000Z' }), error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { amount: 500 })

    expect(res.status).toBe(410)
    const expireCall = supabase.calls.find((c) => c.table === 'quote_requests' && c.method === 'update')
    expect((expireCall!.args[0] as Record<string, unknown>).status).toBe('expired')
  })

  it('requires a positive quote amount', async () => {
    const supabase = makeSupabase({ quote_requests: [{ data: baseQuoteRequest(), error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { amount: -10 })

    expect(res.status).toBe(400)
  })

  it('rejects an implausibly large quote amount', async () => {
    const supabase = makeSupabase({ quote_requests: [{ data: baseQuoteRequest(), error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { amount: 5_000_000 })

    expect(res.status).toBe(400)
  })

  it('returns 409 when a concurrent request already submitted this quote (double-submit guard)', async () => {
    const supabase = makeSupabase({
      quote_requests: [
        { data: baseQuoteRequest(), error: null }, // token lookup
        { data: null, error: null },               // submit claim — lost the race
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { amount: 500 })

    expect(res.status).toBe(409)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('submits a quote for a valid token, logs the update, and sends the quote-submitted event scoped to this quote\'s own org', async () => {
    const supabase = makeSupabase({
      quote_requests: [
        { data: baseQuoteRequest(), error: null },
        { data: { id: 'qr_1' }, error: null },
      ],
      work_order_updates: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { amount: 500, notes: 'Parts + labor' })
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
      name: 'work-order/quote-submitted',
      data: expect.objectContaining({
        work_order_id:    'wo_1',
        quote_request_id: 'qr_1',
        org_id:            'org_1',
        quoted_amount:     500,
        quote_notes:       'Parts + labor',
      }),
    }))
  })
})
