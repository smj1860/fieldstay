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
// Route delegates invoice-creation and event-dispatch to sibling helpers —
// tested in isolation here so this file can focus on the route's own
// concerns: token validation, ownership checks, and the completion claim.
vi.mock('@/app/api/work-orders/[token]/complete/helpers', () => ({
  createVendorInvoice:     vi.fn(async () => ({ ok: true, invoiceId: null })),
  dispatchCompletionEvents: vi.fn(async () => undefined),
}))

import { POST, GET } from '@/app/api/work-orders/[token]/complete/route'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit } from '@/lib/rate-limit'
import { createVendorInvoice, dispatchCompletionEvents } from '@/app/api/work-orders/[token]/complete/helpers'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'neq']) {
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

function postRequest(token: string, body: unknown) {
  return new NextRequest(`http://localhost/api/work-orders/${token}/complete`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

function getRequest(token: string) {
  return new NextRequest(`http://localhost/api/work-orders/${token}/complete`)
}

function callPost(token: string, body: unknown) {
  return POST(postRequest(token, body), { params: Promise.resolve({ token }) })
}

function callGet(token: string) {
  return GET(getRequest(token), { params: Promise.resolve({ token }) })
}

const VALID_TOKEN = 'wo-completion-token-1234567890'

function baseWo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id:                          'wo_1',
    org_id:                      'org_1',
    property_id:                 'prop_1',
    vendor_id:                   'vendor_1',
    status:                      'assigned',
    portal_enabled:              true,
    completion_token_expires_at: null,
    ...overrides,
  }
}

describe('POST /api/work-orders/[token]/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: true } as never)
    vi.mocked(createVendorInvoice).mockResolvedValue({ ok: true, invoiceId: null })
  })

  it('returns 429 and never touches the DB when the IP rate limit is exceeded', async () => {
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: false } as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(429)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 404 for an invalid/nonexistent token before any mutation', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(404)
    expect(dispatchCompletionEvents).not.toHaveBeenCalled()
  })

  it('rejects when the vendor portal is not enabled for this work order', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo({ portal_enabled: false }), error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(403)
  })

  it('rejects a work order that is already completed or cancelled', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo({ status: 'completed' }), error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(409)
  })

  it('rejects an expired token', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo({ completion_token_expires_at: '2020-01-01T00:00:00.000Z' }), error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(410)
  })

  it('IDOR: rejects when the work order\'s assigned vendor belongs to a different org than the work order itself', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_ATTACKER' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(403)
    expect(dispatchCompletionEvents).not.toHaveBeenCalled()
  })

  it('requires a technician name', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: '' })

    expect(res.status).toBe(400)
  })

  it('rejects an implausibly large invoice subtotal before it becomes actual_cost', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe', subtotal: 5_000_000 })

    expect(res.status).toBe(400)
  })

  it('returns 409 (already closed) when a concurrent request wins the completion claim first', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: baseWo(), error: null },       // token lookup
        { data: null, error: null },           // claim update — lost the race
      ],
      vendors: [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(409)
    expect(dispatchCompletionEvents).not.toHaveBeenCalled()
  })

  it('completes a work order with a valid token, creates the invoice, and dispatches completion events', async () => {
    const claimed = { id: 'wo_1', org_id: 'org_1', vendor_id: 'vendor_1', property_id: 'prop_1', wo_number: 'WO-1', source_turnover_id: null }
    const supabase = makeSupabase({
      work_orders: [
        { data: baseWo(), error: null },
        { data: claimed, error: null },
      ],
      vendors:             [{ data: { org_id: 'org_1' }, error: null }],
      work_order_updates:  [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(createVendorInvoice).mockResolvedValue({ ok: true, invoiceId: 'inv_1' })

    const res = await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      notes:           'All done',
      subtotal:        150,
      lineItems: [
        { line_type: 'labor', description: 'Fix sink', quantity: 1, unit_cost: 150, line_total: 150 },
      ],
    })
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(createVendorInvoice).toHaveBeenCalledWith(
      expect.anything(),
      claimed,
      expect.arrayContaining([expect.objectContaining({ line_type: 'labor' })]),
      150,
    )
    expect(dispatchCompletionEvents).toHaveBeenCalledWith(
      expect.anything(), claimed, 'inv_1', VALID_TOKEN, 'All done', 150,
    )
  })

  it('returns 500 without dispatching events when invoice creation fails', async () => {
    const claimed = { id: 'wo_1', org_id: 'org_1', vendor_id: 'vendor_1', property_id: 'prop_1', wo_number: 'WO-1', source_turnover_id: null }
    const supabase = makeSupabase({
      work_orders: [
        { data: baseWo(), error: null },
        { data: claimed, error: null },
      ],
      vendors: [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(createVendorInvoice).mockResolvedValue({ ok: false, error: 'Invoice numbering failed. Please try again.' })

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(500)
    expect(dispatchCompletionEvents).not.toHaveBeenCalled()
  })

  it('accepts a legacy FormData submission (notes-only, no line items)', async () => {
    const claimed = { id: 'wo_1', org_id: 'org_1', vendor_id: 'vendor_1', property_id: 'prop_1', wo_number: 'WO-1', source_turnover_id: null }
    const supabase = makeSupabase({
      work_orders: [
        { data: baseWo(), error: null },
        { data: claimed, error: null },
      ],
      vendors:            [{ data: { org_id: 'org_1' }, error: null }],
      work_order_updates: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const formData = new FormData()
    formData.set('notes', 'Legacy submit')
    formData.set('completedByName', 'Joe')
    const request = new NextRequest(`http://localhost/api/work-orders/${VALID_TOKEN}/complete`, {
      method: 'POST',
      body:   formData,
    })

    const res = await POST(request, { params: Promise.resolve({ token: VALID_TOKEN }) })

    expect(res.status).toBe(200)
  })
})

describe('GET /api/work-orders/[token]/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns work order info for a valid, portal-enabled token', async () => {
    const supabase = makeSupabase({
      work_orders: [{
        data: {
          id: 'wo_1', title: 'Fix sink', description: 'leaky', status: 'assigned',
          portal_enabled: true, completion_token_expires_at: null,
          properties: { name: 'Lakeview Cabin', city: 'Alex City', state: 'AL' },
        },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callGet(VALID_TOKEN)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.workOrder.id).toBe('wo_1')
  })

  it('returns 404 for an invalid token', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callGet(VALID_TOKEN)

    expect(res.status).toBe(404)
  })

  it('returns 404 when the portal is not enabled, even for a token that resolves', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: { id: 'wo_1', portal_enabled: false }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callGet(VALID_TOKEN)

    expect(res.status).toBe(404)
  })

  it('returns 404 for an expired token', async () => {
    const supabase = makeSupabase({
      work_orders: [{
        data: { id: 'wo_1', portal_enabled: true, completion_token_expires_at: '2020-01-01T00:00:00.000Z' },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callGet(VALID_TOKEN)

    expect(res.status).toBe(404)
  })

  // NO RATE LIMITING ON GET: unlike POST (which calls workOrderRatelimit
  // before touching the DB), this GET handler never calls the rate limiter
  // at all — a leaked/enumerated completion_token can be polled/probed for
  // existence (via 200 vs 404) at unlimited rate. Flagged per CLAUDE.md's
  // "Rate limiting on unauthenticated/token-guessable routes" item.
  it('has no rate limiter guarding it — documents current (unthrottled) behavior', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await callGet(VALID_TOKEN)

    expect(workOrderRatelimit.limit).not.toHaveBeenCalled()
  })
})
