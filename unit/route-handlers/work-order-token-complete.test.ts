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
// Every DB write is now one transactional RPC (complete_work_order_via_token),
// so the helper surface is just the non-transactional tail. This file covers
// the route's own concerns — token validation, ownership, payload validation,
// and how it reacts to each RPC outcome.
vi.mock('@/app/api/work-orders/[token]/complete/helpers', () => ({
  finalizeVendorCompletion: vi.fn(async () => undefined),
  dispatchCompletionEvents: vi.fn(async () => undefined),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { POST, GET } from '@/app/api/work-orders/[token]/complete/route'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit } from '@/lib/rate-limit'
import { finalizeVendorCompletion } from '@/app/api/work-orders/[token]/complete/helpers'

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
    // The token lookups use maybeSingle() + tryUnwrap() so that a query ERROR
    // is distinguishable from "no such token" — destructuring data alone made
    // a DB outage render as "Invalid or expired link".
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  // The completion transaction. Defaults to a successful claim with no
  // invoice; individual tests override it to model each RPC outcome.
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    calls.push({ table: `rpc:${fn}`, method: 'rpc', args: [args] })
    return {
      data: {
        claimed:          true,
        previous_status:  'assigned',
        work_order: {
          id: 'wo_1', org_id: 'org_1', vendor_id: 'vendor_1',
          property_id: 'prop_1', wo_number: 'WO-1', source_turnover_id: null,
        },
        invoice_id:       null,
        invoice_number:   null,
        invoice_inserted: false,
      },
      error: null,
    }
  })
  return { from, calls, rpc }
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
    expect(finalizeVendorCompletion).not.toHaveBeenCalled()
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
    expect(finalizeVendorCompletion).not.toHaveBeenCalled()
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

  // This used to assert a 400 on a large client-supplied `subtotal`. The
  // bound was never the real control: the client's figure reached
  // actual_cost at all only because `effectiveSubtotal` fell back to it when
  // no line item survived validation — so a payload with NO valid items and
  // `subtotal: 999999` sailed under the $1M bound and wrote an arbitrary
  // actual_cost on the app's only unauthenticated money-minting path, which
  // then posts to owner_transactions under an ignoreDuplicates upsert (i.e.
  // permanently). The client's figure is now ignored outright, which is the
  // stronger property: assert the value that reaches the RPC, not the status.
  it('ignores a client-supplied subtotal — it can never reach the transaction', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe', subtotal: 5_000_000 })

    expect(res.status).toBe(200)
    // 0, not 5_000_000: the RPC leaves actual_cost untouched on `p_subtotal > 0`.
    expect(supabase.rpc).toHaveBeenCalledWith(
      'complete_work_order_via_token',
      expect.objectContaining({ p_subtotal: 0 }),
    )
  })

  it('rejects a submission whose line items ALL failed validation', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    // The exact shape that used to reach the `subtotal` fallback.
    const res = await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      lineItems: [{ line_type: 'bogus', description: 'Nope', quantity: 1, unit_cost: 10 }],
      subtotal: 999_999,
    })

    expect(res.status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('still bounds the DERIVED total, so line items cannot exceed $1M either', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      lineItems: [{ line_type: 'labor', description: 'Rebuild', quantity: 3, unit_cost: 900_000 }],
    })

    expect(res.status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('derives the total from the surviving items when some are dropped', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    // The non-adversarial direction: the vendor's own subtotal counts the
    // dropped row, so the stored invoice used to exceed the sum of the items
    // printed beneath it. p_subtotal must match the items the RPC inserts.
    await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      lineItems: [
        { line_type: 'labor', description: 'Fix sink', quantity: 2, unit_cost: 75 },
        { line_type: 'labor', description: 'Dropped',  quantity: 0, unit_cost: 500 },  // quantity 0
      ],
      subtotal: 650,
    })

    const args = supabase.rpc.mock.calls[0]![1] as { p_subtotal: number; p_line_items: unknown[] }
    expect(args.p_line_items).toHaveLength(1)
    expect(args.p_subtotal).toBe(150)
  })

  it('returns 409 when the transaction reports the claim was already taken', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    supabase.rpc.mockResolvedValue({
      data: { claimed: false, reason: 'already_closed' }, error: null,
    } as never)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(409)
    // Nothing to finalize, and — unlike the previous saga — nothing to roll
    // back either: the transaction wrote nothing at all.
    expect(finalizeVendorCompletion).not.toHaveBeenCalled()
  })

  it('performs EVERY database write in a single transactional RPC', async () => {
    // The whole point of migration 20260801200000. If the route ever writes
    // outside this call again, part of a completion can be half-applied: an
    // invoice with no completed work order, or the reverse.
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      lineItems: [{ line_type: 'labor', description: 'Fix sink', quantity: 1, unit_cost: 150 }],
      subtotal: 150,
    })

    const writes = supabase.calls.filter((c) =>
      ['insert', 'update', 'upsert', 'delete'].includes(c.method))
    expect(writes).toEqual([])
    expect(supabase.rpc).toHaveBeenCalledWith(
      'complete_work_order_via_token',
      expect.objectContaining({ p_work_order_id: 'wo_1', p_subtotal: 150 }),
    )
  })

  it('passes only validated line items to the transaction', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      lineItems: [
        { line_type: 'labor',   description: 'Fix sink', quantity: 1, unit_cost: 150 },
        { line_type: 'bogus',   description: 'Nope',     quantity: 1, unit_cost: 10 },   // bad type
        { line_type: 'labor',   description: '',         quantity: 1, unit_cost: 10 },   // empty desc
        { line_type: 'labor',   description: 'Free',     quantity: 1, unit_cost: 0 },    // zero cost
      ],
      subtotal: 150,
    })

    const args = supabase.rpc.mock.calls[0]![1] as { p_line_items: unknown[] }
    expect(args.p_line_items).toHaveLength(1)
  })

  it('completes with a valid token and hands the RPC result to finalize', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    supabase.rpc.mockResolvedValue({
      data: {
        claimed:         true,
        previous_status: 'assigned',
        work_order: {
          id: 'wo_1', org_id: 'org_1', vendor_id: 'vendor_1',
          property_id: 'prop_1', wo_number: 'WO-1', source_turnover_id: null,
        },
        invoice_id:       'inv_1',
        invoice_number:   'INV-2026-00001',
        invoice_inserted: true,
      },
      error: null,
    } as never)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, {
      completedByName: 'Joe',
      notes:           'All done',
      lineItems: [{ line_type: 'labor', description: 'Fix sink', quantity: 1, unit_cost: 150 }],
      subtotal: 150,
    })

    expect(res.status).toBe(200)
    expect(finalizeVendorCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        invoiceId:       'inv_1',
        invoiceNumber:   'INV-2026-00001',
        invoiceInserted: true,
      }),
    )
  })

  it('returns 500 and does not finalize when the transaction itself errors', async () => {
    // A failed transaction wrote nothing, so the work order stays claimable and
    // the vendor's retry can still succeed.
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'deadlock detected' } } as never)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, { completedByName: 'Joe' })

    expect(res.status).toBe(500)
    expect(finalizeVendorCompletion).not.toHaveBeenCalled()
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
