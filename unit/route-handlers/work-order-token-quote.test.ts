import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/rate-limit', async () => {
  // checkLimit() is now the only sanctioned way to consult a limiter
  // (lib/rate-limit.ts). The stub delegates to the limiter doubles below
  // so existing `.limit` assertions and fail-policy tests still apply.
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    workOrderRatelimit: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:         checkLimitStub(),
    retryAfterSeconds:  retryAfterSecondsStub,
  }
})
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

// ── POST ─────────────────────────────────────────────────────────────────────
//
// Submission moved from three sequential table writes to one RPC
// (submit_quote_via_token), so the assertions moved with it: what matters now
// is what the route REFUSES to send and what it derives from the RPC's return,
// not which tables it touched in what order. The status/expiry/claim races are
// decided inside the transaction and are covered by the SQL itself.

const VALID_ITEMS = [
  { line_type: 'labor',    description: 'Replace shutoff valve', quantity: 2, unit_cost: 85.5, unit: 'hr' },
  { line_type: 'material', description: '1/2in valve',           quantity: 1, unit_cost: 29.99 },
]

function makeRpcClient(result: unknown, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data: result, error }))
  return { from: vi.fn(() => ({})), rpc }
}

const OK_RESULT = {
  ok:               true,
  quote_request_id: 'qr_1',
  work_order_id:    'wo_1',
  org_id:           'org_1',
  quoted_amount:    200.99,
  line_item_count:  2,
}

describe('POST /api/work-orders/[token]/quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: true } as never)
  })

  it('returns 429 and never touches the DB when the IP rate limit is exceeded', async () => {
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: false } as never)

    const res = await callPost(VALID_TOKEN, { items: VALID_ITEMS })

    expect(res.status).toBe(429)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  // ── Boundary validation, before the RPC is reached ────────────────────────
  //
  // Every case below must NOT reach the database. A malformed submission is
  // the vendor's typo, not a transaction to open.

  it.each([
    ['no items key',        {},                                                                  'at least one line item'],
    ['empty array',         { items: [] },                                                       'at least one line item'],
    ['items not an array',  { items: 'nope' },                                                   'at least one line item'],
    ['blank description',   { items: [{ line_type: 'labor', description: '   ', quantity: 1, unit_cost: 5 }] },  'needs a description'],
    ['zero unit cost',      { items: [{ line_type: 'labor', description: 'x',   quantity: 1, unit_cost: 0 }] },  'unit cost greater than zero'],
    ['negative unit cost',  { items: [{ line_type: 'labor', description: 'x',   quantity: 1, unit_cost: -5 }] }, 'unit cost greater than zero'],
    ['zero quantity',       { items: [{ line_type: 'labor', description: 'x',   quantity: 0, unit_cost: 5 }] },  'quantity greater than zero'],
    ['unknown line type',   { items: [{ line_type: 'hacking', description: 'x', quantity: 1, unit_cost: 5 }] },  'unrecognized type'],
    ['string unit_cost',    { items: [{ line_type: 'labor', description: 'x',   quantity: 1, unit_cost: '5' }] },'unit cost greater than zero'],
  ])('rejects %s without opening a transaction', async (_label, body, fragment) => {
    const supabase = makeRpcClient(OK_RESULT)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res  = await callPost(VALID_TOKEN, body)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toContain(fragment)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  // NaN is neither null nor undefined, so `??` does not catch it; every
  // comparison against it is false, so `<= 0` does not catch it either; and
  // JSON.stringify turns it into null on the way to Postgres. Number.isFinite
  // is the only check that holds.
  it('rejects a NaN quantity, which slips past both ?? and a > 0 comparison', async () => {
    const supabase = makeRpcClient(OK_RESULT)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const req = new NextRequest(`http://localhost/api/work-orders/${VALID_TOKEN}/quote`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      // JSON has no NaN literal, so this is the shape it actually arrives in.
      body:    '{"items":[{"line_type":"labor","description":"x","quantity":null,"unit_cost":5}]}',
    })
    const res = await POST(req, { params: Promise.resolve({ token: VALID_TOKEN }) })

    expect(res.status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects more line items than the cap', async () => {
    const supabase = makeRpcClient(OK_RESULT)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const items = Array.from({ length: 101 }, () => ({
      line_type: 'labor', description: 'x', quantity: 1, unit_cost: 1,
    }))
    const res  = await callPost(VALID_TOKEN, { items })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toContain('at most 100')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  // ── RPC outcomes ─────────────────────────────────────────────────────────

  it.each([
    ['not_found',   404],
    ['not_pending', 409],
    ['expired',     410],
  ])('maps the RPC reason %s to HTTP %i and sends no event', async (reason, status) => {
    const supabase = makeRpcClient({ ok: false, reason })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { items: VALID_ITEMS })

    expect(res.status).toBe(status)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  // The function raises (rather than returns) when the DERIVED total exceeds
  // the cap, so the inserted rows roll back with it. 23514 is the vendor's
  // input problem — a 503 would tell them to retry something that will fail
  // identically every time.
  it('maps the total-exceeds-cap check violation to a 400, not a 503', async () => {
    const supabase = makeRpcClient(null, { code: '23514', message: 'quote total 5000000 exceeds maximum 1000000' })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res  = await callPost(VALID_TOKEN, { items: VALID_ITEMS })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toContain('1,000,000')
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('surfaces an unexpected RPC error as a 503 without sending an event', async () => {
    const supabase = makeRpcClient(null, { code: '08006', message: 'connection failure' })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { items: VALID_ITEMS })

    expect(res.status).toBe(503)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('treats a null RPC result as a failure rather than a silent success', async () => {
    const supabase = makeRpcClient(null)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { items: VALID_ITEMS })

    expect(res.status).toBe(404)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  // ── The happy path ───────────────────────────────────────────────────────

  it('submits the itemized quote and reports the SERVER-derived total', async () => {
    const supabase = makeRpcClient(OK_RESULT)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res  = await callPost(VALID_TOKEN, { items: VALID_ITEMS, notes: 'Parts + labor' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true, quotedAmount: 200.99, lineItemCount: 2 })

    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
      name: 'work-order/quote-submitted',
      data: expect.objectContaining({
        work_order_id:    'wo_1',
        quote_request_id: 'qr_1',
        org_id:           'org_1',
        // From the RPC's return, NOT from anything the client sent.
        quoted_amount:    200.99,
        quote_notes:      'Parts + labor',
      }),
    }))
  })

  // The whole point of deriving the total server-side. A client that states its
  // own amount must not be able to influence what is recorded — the field is
  // not read at all, and the response still carries the RPC's figure.
  it('ignores a client-supplied total entirely', async () => {
    const supabase = makeRpcClient(OK_RESULT)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res  = await callPost(VALID_TOKEN, { items: VALID_ITEMS, amount: 999_999, quotedAmount: 999_999 })
    const json = await res.json()

    expect(json.quotedAmount).toBe(200.99)
    const [, args] = vi.mocked(supabase.rpc).mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(JSON.stringify(args)).not.toContain('999999')
  })

  it('trims descriptions and normalizes an absent note to an empty string for the RPC', async () => {
    const supabase = makeRpcClient(OK_RESULT)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await callPost(VALID_TOKEN, {
      items: [{ line_type: 'labor', description: '  Replace valve  ', quantity: 1, unit_cost: 10 }],
    })

    const [fn, args] = vi.mocked(supabase.rpc).mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(fn).toBe('submit_quote_via_token')
    expect(args.p_quote_token).toBe(VALID_TOKEN)
    expect(args.p_notes).toBe('')
    const items = args.p_line_items as Array<{ description: string }>
    expect(items[0]!.description).toBe('Replace valve')
  })
})
