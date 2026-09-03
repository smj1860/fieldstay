import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/guidebook/helpers', () => ({
  getActiveSponsorCount: vi.fn(),
  // resolvePlanCredit is pure — re-implement its documented rule here rather
  // than pulling in the real module, keeping this test hermetic. Flat $5 per
  // active sponsor; unit/lib/guidebook-plan-credit.test.ts covers the real one.
  resolvePlanCredit: vi.fn((count: number) => Math.max(0, count) * 500),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { invoiceItems: { create: vi.fn() } },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { guidebookBillingCreditHandler } from '@/lib/inngest/functions/guidebook-billing-credit-handler'
import { getActiveSponsorCount, resolvePlanCredit } from '@/lib/guidebook/helpers'
import { stripe } from '@/lib/stripe/client'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function creditEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      orgId:            'org_1',
      stripeCustomerId: 'cus_1',
      currentPeriodEnd: 1_800_000_000,
      ...overrides,
    },
  }
}

describe('guidebookBillingCreditHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('posts a $25 invoice credit and audit-logs the 6-sponsor reward reason', async () => {
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(6)
    ;(stripe.invoiceItems.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ii_1' })

    const result = await invokeHandler(guidebookBillingCreditHandler, {
      event: creditEvent(),
      step:  makeStep(),
    })

    expect(resolvePlanCredit).toHaveBeenCalledWith(6)
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer:    'cus_1',
        amount:      -3000,
        currency:    'usd',
        description: expect.stringContaining('6 Sponsors — $30 off'),
      }),
      { idempotencyKey: 'guidebook-credit-org_1-1800000000' },
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'billing.plan_credit.applied',
        targetType: 'organization',
        metadata:   { reason: 'per_sponsor_credit', activeSponsorCount: 6, planCreditCents: 3000 },
      }),
    )
    expect(result).toEqual({ orgId: 'org_1', activeSponsorCount: 6, planCreditCents: 3000 })
  })

  it('posts a $25 invoice credit for 5 active sponsors — the one count whose amount is unchanged', async () => {
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(5)
    ;(stripe.invoiceItems.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ii_2' })

    const result = await invokeHandler(guidebookBillingCreditHandler, {
      event: creditEvent(),
      step:  makeStep(),
    })

    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: -2500, description: expect.stringContaining('5 Sponsors — $25 off') }),
      expect.anything(),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { reason: 'per_sponsor_credit', activeSponsorCount: 5, planCreditCents: 2500 },
      }),
    )
    expect(result).toEqual({ orgId: 'org_1', activeSponsorCount: 5, planCreditCents: 2500 })
  })

  it('is a no-op at ZERO sponsors — never calls Stripe or writes an audit event', async () => {
    // The only count that earns nothing now. Four sponsors used to land here
    // and earned $0 despite being most of the way to a full guidebook; it now
    // earns $20 (covered below).
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(0)

    const result = await invokeHandler(guidebookBillingCreditHandler, {
      event: creditEvent(),
      step:  makeStep(),
    })

    expect(stripe.invoiceItems.create).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ skipped: true, reason: 'no_active_sponsors', activeSponsorCount: 0 })
  })

  it('idempotency: replaying the same billing-cycle event twice reuses the identical Stripe idempotency key', async () => {
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(6)
    ;(stripe.invoiceItems.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ii_1' })

    await invokeHandler(guidebookBillingCreditHandler, { event: creditEvent(), step: makeStep() })
    await invokeHandler(guidebookBillingCreditHandler, { event: creditEvent(), step: makeStep() })

    expect(stripe.invoiceItems.create).toHaveBeenCalledTimes(2)
    const [, firstOpts]  = (stripe.invoiceItems.create as ReturnType<typeof vi.fn>).mock.calls[0]
    const [, secondOpts] = (stripe.invoiceItems.create as ReturnType<typeof vi.fn>).mock.calls[1]
    // Same org + same billing period end => same idempotency key both times,
    // so Stripe itself collapses a retried event into a single credit line.
    expect(firstOpts).toEqual(secondOpts)
    expect(firstOpts).toEqual({ idempotencyKey: 'guidebook-credit-org_1-1800000000' })
  })

  // THE most valuable test in this file: the guard against double-crediting.
  //
  // guidebook-daily-monitor dispatches whenever the subscription renews within
  // 48 hours and runs daily, so a period is normally evaluated on two
  // CONSECUTIVE days. The idempotency key is (org, period end) only, so a
  // sponsor count that changes between those two days replays the same key
  // with a different amount, which Stripe rejects outright.
  //
  // Under the old thresholds this needed a 5 -> 6 crossing inside 48 hours and
  // was rare. Under per-sponsor credit ANY add or cancellation in that window
  // does it, so this path is now routine — which is exactly why it must stay a
  // no-op rather than a failure, and why the log is info rather than warn.
  it('treats a Stripe idempotency_error (same key, different amount after a count change) as a no-op, not a failure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(6)
    ;(stripe.invoiceItems.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters.'), {
        type: 'idempotency_error',
      }),
    )

    const result = await invokeHandler(guidebookBillingCreditHandler, {
      event: creditEvent(),
      step:  makeStep(),
    })

    expect(result).toEqual({
      skipped: true, reason: 'credit_already_posted_this_period', activeSponsorCount: 6,
    })
    expect(info).toHaveBeenCalled()
    // The credit line from the first evaluation is the one that stands, so a
    // second audit entry would claim a credit that was never posted.
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('still throws (so Inngest retries) on any non-idempotency Stripe failure', async () => {
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(6)
    ;(stripe.invoiceItems.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Request timed out'), { type: 'api_connection_error' }),
    )

    await expect(
      invokeHandler(guidebookBillingCreditHandler, { event: creditEvent(), step: makeStep() }),
    ).rejects.toThrow('Request timed out')
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
