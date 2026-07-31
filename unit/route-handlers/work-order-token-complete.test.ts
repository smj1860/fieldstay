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
// Route delegates invoice-creation and event-dispatch to sibling helpers —
// tested in isolation here so this file can focus on the route's own
// concerns: token validation, ownership checks, and the completion claim.
vi.mock('@/app/api/work-orders/[token]/complete/helpers', () => ({
  createVendorInvoice:       vi.fn(async () => ({ ok: true, invoiceId: null, invoiceNumber: null, insertedByThisRequest: false })),
  finalizeVendorCompletion:  vi.fn(async () => undefined),
  rollbackUnclaimedInvoice:  vi.fn(async () => undefined),
  // Still exported and still called — but from inside finalizeVendorCompletion
  // now, so this file asserts on that boundary and
  // work-order-token-complete-helpers.test.ts covers what it does.
  dispatchCompletionEvents:  vi.fn(async () => undefined),
}))

import { POST, GET } from '@/app/api/work-orders/[token]/complete/route'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit } from '@/lib/rate-limit'
import {
  createVendorInvoice,
  dispatchCompletionEvents,
  finalizeVendorCompletion,
  rollbackUnclaimedInvoice,
} from '@/app/api/work-orders/[token]/complete/helpers'

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
    vi.mocked(createVendorInvoice).mockResolvedValue({
      ok: true, invoiceId: null, invoiceNumber: null, insertedByThisRequest: false,
    })
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
    vi.mocked(createVendorInvoice).mockResolvedValue({
      ok: true, invoiceId: 'inv_1', invoiceNumber: 'INV-2026-00001', insertedByThisRequest: true,
    })

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
    // Called with the work order read from the completion token, not the
    // claim result — the invoice is created before the claim exists.
    expect(createVendorInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'wo_1', org_id: 'org_1', vendor_id: 'vendor_1', property_id: 'prop_1' }),
      expect.arrayContaining([expect.objectContaining({ line_type: 'labor' })]),
      150,
    )
    expect(rollbackUnclaimedInvoice).not.toHaveBeenCalled()
    expect(finalizeVendorCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        claimed,
        subtotal:       150,
        notes:          'All done',
        token:          VALID_TOKEN,
        previousStatus: 'assigned',
        safeLineItems:  expect.arrayContaining([expect.objectContaining({ line_type: 'labor' })]),
      }),
    )
  })

  // REGRESSION: the work order must not be observable as 'completed' until
  // its invoice row exists. With the claim first, a reader that polled
  // between the two statements saw a completed work order with no invoice
  // (this is exactly what e2e/specs/21-work-order-offline.spec.ts:161 caught
  // once the reconnect drain stopped waiting out its backoff), and an
  // invoice step that FAILED after the claim left that state permanent —
  // every vendor retry from then on could only get the already-closed 409.
  it('creates the invoice before it flips the work order to completed', async () => {
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

    // The helper is mocked, so it records its own position in the same
    // ordered call log the supabase double writes to.
    vi.mocked(createVendorInvoice).mockImplementation(async () => {
      supabase.calls.push({ table: 'work_order_invoices', method: 'upsert', args: [] })
      return { ok: true, invoiceId: 'inv_1', invoiceNumber: 'INV-2026-00001', insertedByThisRequest: true }
    })

    await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      subtotal:        150,
      lineItems: [{ line_type: 'labor', description: 'Fix sink', quantity: 1, unit_cost: 150, line_total: 150 }],
    })

    const invoiceAt = supabase.calls.findIndex((c) => c.table === 'work_order_invoices' && c.method === 'upsert')
    const claimAt   = supabase.calls.findIndex((c) => c.table === 'work_orders' && c.method === 'update')

    expect(invoiceAt).toBeGreaterThanOrEqual(0)
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(invoiceAt).toBeLessThan(claimAt)
  })

  it('rolls back the invoice it created when it loses the completion claim', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: baseWo(), error: null },       // token lookup
        { data: null, error: null },           // claim update — lost the race
      ],
      vendors: [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(createVendorInvoice).mockResolvedValue({
      ok: true, invoiceId: 'inv_1', invoiceNumber: 'INV-2026-00001', insertedByThisRequest: true,
    })

    const res = await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      subtotal:        150,
      lineItems: [{ line_type: 'labor', description: 'Fix sink', quantity: 1, unit_cost: 150, line_total: 150 }],
    })

    expect(res.status).toBe(409)
    expect(rollbackUnclaimedInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 'inv_1', insertedByThisRequest: true }),
    )
    // Never invent line items, an audit trail, or events for a lost claim.
    expect(finalizeVendorCompletion).not.toHaveBeenCalled()
  })

  it('hands the lost claim an invoice it did not insert, so the rollback can decline it', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: baseWo(), error: null },
        { data: null, error: null },
      ],
      vendors: [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    // The upsert conflicted: this invoice belongs to an earlier attempt, so
    // deleting it here would destroy a row this request does not own.
    vi.mocked(createVendorInvoice).mockResolvedValue({
      ok: true, invoiceId: 'inv_existing', invoiceNumber: null, insertedByThisRequest: false,
    })

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(409)
    expect(rollbackUnclaimedInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 'inv_existing', insertedByThisRequest: false }),
    )
  })

  it('returns 500 and leaves the work order claimable when invoice creation fails', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(createVendorInvoice).mockResolvedValue({ ok: false, error: 'Invoice numbering failed. Please try again.' })

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(500)
    expect(dispatchCompletionEvents).not.toHaveBeenCalled()
    // The whole point of the reorder: a failed invoice step must leave the
    // work order still completable, so the vendor's retry can succeed.
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'update')).toBe(false)
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
