import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
  },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { POST } from '@/app/api/invoices/[invoiceId]/checkout/route'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { logAuditEvent } from '@/lib/audit'

const ORG_ID = 'org_1'
const USER_ID = 'user_1'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'update', 'eq']) {
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
    supabase:   {} as never,
    membership: { org_id: ORG_ID, role: 'admin', org: {} as never },
  } as never)
  vi.mocked(createServiceClient).mockReturnValue(supabase as never)
}

function baseInvoice(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id:                          'inv_1',
    status:                      'pending',
    total:                       500,
    platform_fee_amount:         25,
    stripe_checkout_session_id:  null,
    work_order_id:               'wo_1',
    vendors: {
      id: 'vendor_1', name: 'Ace Plumbing',
      stripe_connect_account_id:      'acct_1',
      stripe_connect_charges_enabled: true,
    },
    properties: { name: 'Lakeview Cabin' },
    ...overrides,
  }
}

function postRequest(invoiceId: string) {
  return new NextRequest(`http://localhost/api/invoices/${invoiceId}/checkout`, { method: 'POST' })
}

function call(invoiceId: string) {
  return POST(postRequest(invoiceId), { params: Promise.resolve({ invoiceId }) })
}

describe('POST /api/invoices/[invoiceId]/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
    process.env.STRIPE_PLATFORM_FEE_PCT = '5'
  })

  it('returns 401 (the route\'s own try/catch around requireOrgMember) for an unauthenticated caller, before touching the DB', async () => {
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    const res = await call('inv_1')

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('IDOR: returns 404 for an invoiceId belonging to a different org — the lookup is scoped by org_id, not just id', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: null, error: null }] })
    mockAuthed(supabase)

    const res = await call('other_org_invoice')

    expect(res.status).toBe(404)
    const eqCalls = supabase.calls.filter((c) => c.table === 'work_order_invoices' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'other_org_invoice')).toBe(true)
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('rejects an already-paid invoice', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: baseInvoice({ status: 'paid' }), error: null }] })
    mockAuthed(supabase)

    const res = await call('inv_1')

    expect(res.status).toBe(409)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('rejects a cancelled invoice', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: baseInvoice({ status: 'cancelled' }), error: null }] })
    mockAuthed(supabase)

    const res = await call('inv_1')

    expect(res.status).toBe(409)
  })

  it('rejects when the vendor has not completed Stripe Connect onboarding', async () => {
    const supabase = makeSupabase({
      work_order_invoices: [{
        data: baseInvoice({ vendors: { id: 'vendor_1', name: 'Ace Plumbing', stripe_connect_account_id: null, stripe_connect_charges_enabled: false } }),
        error: null,
      }],
    })
    mockAuthed(supabase)

    const res = await call('inv_1')

    expect(res.status).toBe(422)
  })

  it('rejects when the vendor\'s Stripe account exists but charges are not yet enabled', async () => {
    const supabase = makeSupabase({
      work_order_invoices: [{
        data: baseInvoice({ vendors: { id: 'vendor_1', name: 'Ace Plumbing', stripe_connect_account_id: 'acct_1', stripe_connect_charges_enabled: false } }),
        error: null,
      }],
    })
    mockAuthed(supabase)

    const res = await call('inv_1')

    expect(res.status).toBe(422)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('reuses an existing still-open checkout session instead of creating a new one', async () => {
    const supabase = makeSupabase({
      work_order_invoices: [{ data: baseInvoice({ stripe_checkout_session_id: 'cs_existing' }), error: null }],
    })
    mockAuthed(supabase)
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ status: 'open', url: 'https://checkout.stripe.com/pay/cs_existing' } as never)

    const res = await call('inv_1')
    const json = await res.json()

    expect(json).toEqual({ url: 'https://checkout.stripe.com/pay/cs_existing' })
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('creates a new session when the existing session id no longer resolves (expired/not found)', async () => {
    const supabase = makeSupabase({
      work_order_invoices: [{ data: baseInvoice({ stripe_checkout_session_id: 'cs_gone' }), error: null }],
    })
    mockAuthed(supabase)
    vi.mocked(stripe.checkout.sessions.retrieve).mockRejectedValue(new Error('No such checkout session'))
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.com/pay/cs_new' } as never)

    const res = await call('inv_1')
    const json = await res.json()

    expect(json).toEqual({ url: 'https://checkout.stripe.com/pay/cs_new' })
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1)
  })

  it('creates a new session when no existing session id is stored — metadata is server-derived (org_id from membership, never the client)', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: baseInvoice(), error: null }] })
    mockAuthed(supabase)
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.com/pay/cs_new' } as never)

    const res = await call('inv_1')
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ url: 'https://checkout.stripe.com/pay/cs_new' })

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      success_url: 'https://app.fieldstay.test/invoices/inv_1?paid=true',
      cancel_url:  'https://app.fieldstay.test/invoices/inv_1?cancelled=true',
      metadata: expect.objectContaining({
        invoice_id:    'inv_1',
        work_order_id: 'wo_1',
        org_id:        ORG_ID,
      }),
      payment_intent_data: expect.objectContaining({
        transfer_data: { destination: 'acct_1' },
        metadata: expect.objectContaining({
          invoice_id: 'inv_1', work_order_id: 'wo_1', org_id: ORG_ID, vendor_id: 'vendor_1',
        }),
      }),
    }))

    // Stores the session id for reuse, scoped to this invoice AND this org
    const updateCall = supabase.calls.find((c) => c.table === 'work_order_invoices' && c.method === 'update')
    expect(updateCall).toBeDefined()
    const updateEq = supabase.calls.filter((c) => c.table === 'work_order_invoices' && c.method === 'eq')
    expect(updateEq.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, action: 'work_order.invoice.checkout_started', targetType: 'work_order_invoice', targetId: 'inv_1',
    }))
  })

  it('computes the application fee fresh from the current STRIPE_PLATFORM_FEE_PCT rather than trusting the stored platform_fee_amount', async () => {
    const supabase = makeSupabase({ work_order_invoices: [{ data: baseInvoice({ total: 1000, platform_fee_amount: 999 }), error: null }] })
    mockAuthed(supabase)
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.com/pay/cs_new' } as never)

    await call('inv_1')

    // 5% of $1000 = $50 = 5000 cents, not the stale 999-cent stored value
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      payment_intent_data: expect.objectContaining({ application_fee_amount: 5000 }),
    }))
  })
})
