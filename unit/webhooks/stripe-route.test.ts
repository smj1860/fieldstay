import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/stripe/client', () => ({
  STRIPE_API_VERSION: '2025-02-24.acacia',
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
vi.mock('@/app/api/webhooks/stripe/handlers/core-billing', () => ({
  handleCheckoutSessionBilling:  vi.fn(),
  handleCoreSubscriptionUpdate:  vi.fn(),
  handleCoreSubscriptionCancelled: vi.fn(),
  handleCoreInvoicePaymentFailed:  vi.fn(),
}))

import { POST } from '@/app/api/webhooks/stripe/route'
import { stripe } from '@/lib/stripe/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { handleWorkOrderInvoicePaid } from '@/app/api/webhooks/stripe/handlers/work-order-invoice'
import { handleSponsorCheckoutCompleted, handleSponsorPaymentFailed } from '@/app/api/webhooks/stripe/handlers/guidebook-sponsor'
import { handleCheckoutSessionBilling, handleCoreSubscriptionUpdate, handleCoreSubscriptionCancelled, handleCoreInvoicePaymentFailed } from '@/app/api/webhooks/stripe/handlers/core-billing'

// Minimal chainable Supabase mock — every builder method returns itself,
// and the chain resolves (via `then`) to whatever result was configured for
// that table. Good enough for routes that never branch on query filters.
// A `.delete()` call on a table is tracked separately (with its `.eq(...)`
// args) and resolves against `deleteResult` rather than the table's normal
// `perTable` result, so tests can assert the dedup-release path indepen-
// dently of the insert path on the same table.
function makeSupabase(
  perTable: Record<string, { data?: unknown; error?: unknown }>,
  deleteResult: { data?: unknown; error?: unknown } = { data: null, error: null },
) {
  const deleteCalls: { table: string; eqArgs: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    let isDelete = false
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.insert = vi.fn(() => chain)
    chain.update = vi.fn(() => chain)
    chain.delete = vi.fn(() => {
      isDelete = true
      deleteCalls.push({ table, eqArgs: [] })
      return chain
    })
    chain.eq     = vi.fn((...args: unknown[]) => {
      if (isDelete) deleteCalls[deleteCalls.length - 1].eqArgs = args
      return chain
    })
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(isDelete ? deleteResult : result).then(resolve)
    return chain
  })
  return { from, deleteCalls }
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

  it('happy path leaves the dedup row in place and returns 200', async () => {
    const supabaseMock = makeSupabase({ stripe_processed_events: { error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabaseMock)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_ok',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_ok', metadata: { org_id: 'org_1' }, customer: 'cus_1' } },
    })

    const res  = await POST(postRequest('{}', 'valid-signature'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ received: true })
    expect(supabaseMock.deleteCalls).toHaveLength(0)
  })

  it('releases the dedup claim and returns 500 when a handler throws', async () => {
    const supabaseMock = makeSupabase({ stripe_processed_events: { error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabaseMock)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_fail',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_fail', metadata: { org_id: 'org_1' }, customer: 'cus_1' } },
    })
    ;(handleCheckoutSessionBilling as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('transient DB error'))

    const res  = await POST(postRequest('{}', 'valid-signature'))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body).toEqual({ error: 'Handler failed' })
    expect(supabaseMock.deleteCalls).toEqual([
      { table: 'stripe_processed_events', eqArgs: ['stripe_event_id', 'evt_fail'] },
    ])
  })

  it('re-enters the handler on a second delivery after the dedup claim was released', async () => {
    ;(handleCheckoutSessionBilling as ReturnType<typeof vi.fn>).mockReset()

    // First delivery: handler throws, dedup row is released (delete succeeds).
    const firstAttemptSupabase = makeSupabase({ stripe_processed_events: { error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValueOnce(firstAttemptSupabase)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_retry',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_retry', metadata: { org_id: 'org_1' }, customer: 'cus_1' } },
    })
    ;(handleCheckoutSessionBilling as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('transient DB error'))

    const firstRes = await POST(postRequest('{}', 'valid-signature'))
    expect(firstRes.status).toBe(500)

    // Second delivery of the same event.id: dedup insert succeeds again
    // (the row was deleted), so it re-enters the switch and actually runs
    // the handler instead of being silently discarded as a duplicate.
    const secondAttemptSupabase = makeSupabase({ stripe_processed_events: { error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValueOnce(secondAttemptSupabase)

    const secondRes = await POST(postRequest('{}', 'valid-signature'))

    expect(secondRes.status).toBe(200)
    expect(handleCheckoutSessionBilling).toHaveBeenCalledTimes(2)
  })
})

// ── Non-core subscriptions must never reach core billing ────────────────────
//
// onSubscriptionUpserted used to check ONLY `feature === 'repuguard'` and let
// everything else fall through to handleCoreSubscriptionUpdate. Guidebook
// sponsor subscriptions carry org_id in subscription_data.metadata
// (app/actions/guidebook.ts), so core billing's metadata-first resolution
// RESOLVED the sponsoring org, never reached its "not one of our plans" guard,
// and the sponsor price fell to the `?? 'starter'` default — every sponsor
// checkout rewrote the sponsoring org to Starter/15 properties and overwrote
// its stripe_subscription_id with the sponsor's.
describe('POST /api/webhooks/stripe — non-core subscription isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ stripe_processed_events: { error: null } })
    )
  })

  const emit = (type: string, metadata: Record<string, string>) => {
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'evt_iso', type,
      data: { object: { id: 'sub_x', customer: 'cus_x', status: 'active', metadata,
                        items: { data: [{ price: { id: 'price_sponsor_monthly' } }] } } },
    })
    return POST(postRequest('{}', 'sig'))
  }

  it('does NOT route a guidebook sponsor subscription update into core billing', async () => {
    await emit('customer.subscription.updated', {
      feature: 'guidebook_sponsor', org_id: 'org_1', guidebook_sponsor_id: 'spon_1',
    })

    expect(handleCoreSubscriptionUpdate).not.toHaveBeenCalled()
  })

  it('does NOT route a sponsor subscription CREATED into core billing either', async () => {
    await emit('customer.subscription.created', {
      feature: 'guidebook_sponsor', org_id: 'org_1', guidebook_sponsor_id: 'spon_1',
    })

    expect(handleCoreSubscriptionUpdate).not.toHaveBeenCalled()
  })

  it('does NOT let a legacy repuguard subscription cancel the org core plan', async () => {
    // RepuGuard is included in every plan now — no subscription is created for
    // it — but a legacy subscription can still exist in Stripe, and its
    // deletion must not set the org's core plan_status to 'cancelled'.
    await emit('customer.subscription.deleted', { feature: 'repuguard', org_id: 'org_1' })

    expect(handleCoreSubscriptionCancelled).not.toHaveBeenCalled()
  })

  it('still routes an untagged subscription to core billing', async () => {
    // Core billing is the ABSENCE of a feature tag: createCheckoutSession
    // stamps { org_id, plan } and nothing else.
    await emit('customer.subscription.updated', { org_id: 'org_1', plan: 'growth' })

    expect(handleCoreSubscriptionUpdate).toHaveBeenCalledTimes(1)
  })
})

// ── invoice.subscription shape + core-billing dunning ───────────────────────
describe('POST /api/webhooks/stripe — invoice events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ stripe_processed_events: { error: null } })
    )
  })

  const emitInvoice = (type: string, invoice: Record<string, unknown>) => {
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'evt_inv', type, data: { object: { id: 'in_1', ...invoice } },
    })
    return POST(postRequest('{}', 'sig'))
  }

  it('notifies the PM when a CORE billing invoice fails — the dunning gap', () => {
    // This handler used to act only on guidebook_sponsor subscriptions, so a
    // declined card on the primary revenue path told the PM nothing.
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sub_1', customer: 'cus_1', metadata: { org_id: 'org_1', plan: 'growth' },
    })

    return emitInvoice('invoice.payment_failed', { subscription: 'sub_1' }).then(() => {
      expect(handleCoreInvoicePaymentFailed).toHaveBeenCalledOnce()
    })
  })

  it('does NOT route a sponsor invoice failure into core billing dunning', async () => {
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sub_s', customer: 'cus_s',
      metadata: { feature: 'guidebook_sponsor', org_id: 'org_1', guidebook_sponsor_id: 'spon_1' },
    })

    await emitInvoice('invoice.payment_failed', { subscription: 'sub_s' })

    expect(handleSponsorPaymentFailed).toHaveBeenCalledOnce()
    expect(handleCoreInvoicePaymentFailed).not.toHaveBeenCalled()
  })

  it('reports an unexpected invoice.subscription shape instead of silently returning', async () => {
    // `invoice.subscription as string | null` type-checked nothing. Stripe has
    // moved subscription linkage on Invoice in later API versions, so an
    // apiVersion bump would make this an object (or undefined), send the
    // handler down its `if (!subId) return` path, and stop every sponsor
    // payment-failure event with nothing logged.
    await emitInvoice('invoice.payment_failed', { subscription: { id: 'sub_1' } })

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        site: 'webhook.stripe.invoice_payment_failed.subscription_shape',
      }),
    )
  })

  it('treats a genuinely absent subscription as a no-op, not a report', async () => {
    // A one-off invoice has no subscription at all — that is normal, not drift.
    await emitInvoice('invoice.payment_failed', { subscription: null })

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
  })
})
