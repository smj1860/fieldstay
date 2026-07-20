import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    webhooks:      { constructEvent: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))
vi.mock('@/app/api/webhooks/stripe/handlers/work-order-invoice', () => ({
  handleWorkOrderInvoicePaid: vi.fn(),
}))
vi.mock('@/app/api/webhooks/stripe/handlers/guidebook-sponsor', () => ({
  handleSponsorCheckoutCompleted:      vi.fn(),
  handleSponsorSubscriptionCancelled:  vi.fn(),
  handleSponsorPaymentFailed:          vi.fn(),
  handleSponsorPaymentRecovered:       vi.fn(),
}))
vi.mock('@/app/api/webhooks/stripe/handlers/repuguard-subscription', () => ({
  handleRepuguardSubscriptionUpdated:   vi.fn(),
  handleRepuguardSubscriptionCancelled: vi.fn(),
}))
vi.mock('@/app/api/webhooks/stripe/handlers/core-billing', () => ({
  handleCheckoutSessionBilling:  vi.fn(),
  handleCoreSubscriptionUpdate:  vi.fn(),
  handleCoreSubscriptionCancelled: vi.fn(),
}))

import { POST } from '@/app/api/webhooks/stripe/route'
import { stripe } from '@/lib/stripe/client'
import { createServiceClient } from '@/lib/supabase/server'
import { handleWorkOrderInvoicePaid } from '@/app/api/webhooks/stripe/handlers/work-order-invoice'
import { handleSponsorCheckoutCompleted } from '@/app/api/webhooks/stripe/handlers/guidebook-sponsor'
import { handleCheckoutSessionBilling } from '@/app/api/webhooks/stripe/handlers/core-billing'

// Minimal chainable Supabase mock — every builder method returns itself,
// and the chain resolves (via `then`) to whatever result was configured for
// that table. Good enough for routes that never branch on query filters.
function makeSupabase(perTable: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.insert = vi.fn(() => chain)
    chain.update = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

function postRequest(body: string, signature: string | null) {
  const headers: HeadersInit = signature ? { 'stripe-signature': signature } : {}
  return new NextRequest('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers,
    body,
  })
}

describe('POST /api/webhooks/stripe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ stripe_processed_events: { error: null } })
    )
  })

  it('rejects a request with no stripe-signature header before touching the DB', async () => {
    const res = await POST(postRequest('{}', null))

    expect(res.status).toBe(400)
    expect(stripe.webhooks.constructEvent).not.toHaveBeenCalled()
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a request with an invalid signature before touching the DB', async () => {
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('signature mismatch')
    })

    const res = await POST(postRequest('{}', 'bad-signature'))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('short-circuits on a duplicate delivery without dispatching to any handler', async () => {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ stripe_processed_events: { error: { code: '23505' } } })
    )
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_dup',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', metadata: { org_id: 'org_1' }, customer: 'cus_1' } },
    })

    const res = await POST(postRequest('{}', 'valid-signature'))

    expect(res.status).toBe(200)
    expect(handleCheckoutSessionBilling).not.toHaveBeenCalled()
  })

  it('routes checkout.session.completed with invoice_id + org_id to the work-order-invoice handler', async () => {
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id:       'cs_1',
          metadata: { invoice_id: 'inv_1', org_id: 'org_1' },
          customer: 'cus_1',
        },
      },
    })

    await POST(postRequest('{}', 'valid-signature'))

    expect(handleWorkOrderInvoicePaid).toHaveBeenCalledTimes(1)
    expect(handleWorkOrderInvoicePaid).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'cs_1' }),
      'inv_1',
      'org_1',
    )
    expect(handleCheckoutSessionBilling).not.toHaveBeenCalled()
  })

  it('routes checkout.session.completed with feature=guidebook_sponsor to the sponsor handler', async () => {
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_2',
      type: 'checkout.session.completed',
      data: {
        object: {
          id:       'cs_2',
          metadata: { feature: 'guidebook_sponsor' },
          customer: 'cus_1',
        },
      },
    })

    await POST(postRequest('{}', 'valid-signature'))

    expect(handleSponsorCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect(handleWorkOrderInvoicePaid).not.toHaveBeenCalled()
  })

  it('routes a plain checkout.session.completed (org_id + customer only) to the core billing handler', async () => {
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_3',
      type: 'checkout.session.completed',
      data: {
        object: {
          id:       'cs_3',
          metadata: { org_id: 'org_1' },
          customer: 'cus_1',
        },
      },
    })

    await POST(postRequest('{}', 'valid-signature'))

    expect(handleCheckoutSessionBilling).toHaveBeenCalledWith(expect.anything(), 'org_1', 'cus_1')
  })
})
