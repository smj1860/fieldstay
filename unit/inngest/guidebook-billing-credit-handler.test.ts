import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/guidebook/helpers', () => ({
  getActiveSponsorCount: vi.fn(),
  // resolvePlanCredit is pure — re-implement its documented thresholds here
  // rather than pulling in the real module, keeping this test hermetic.
  resolvePlanCredit: vi.fn((count: number) => (count >= 6 ? 2500 : count >= 5 ? 1000 : 0)),
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
        amount:      -2500,
        currency:    'usd',
        description: expect.stringContaining('6-Sponsor Reward'),
      }),
      { idempotencyKey: 'guidebook-credit-org_1-1800000000' },
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'billing.plan_credit.applied',
        targetType: 'organization',
        metadata:   { reason: '6_sponsor_reward' },
      }),
    )
    expect(result).toEqual({ orgId: 'org_1', activeSponsorCount: 6, planCreditCents: 2500 })
  })

  it('posts a $10 invoice credit for exactly 5 active sponsors', async () => {
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(5)
    ;(stripe.invoiceItems.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ii_2' })

    const result = await invokeHandler(guidebookBillingCreditHandler, {
      event: creditEvent(),
      step:  makeStep(),
    })

    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: -1000, description: expect.stringContaining('5-Sponsor Reward') }),
      expect.anything(),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { reason: '5_sponsor_reward' } }),
    )
    expect(result).toEqual({ orgId: 'org_1', activeSponsorCount: 5, planCreditCents: 1000 })
  })

  it('is a no-op below the 5-sponsor credit threshold — never calls Stripe or writes an audit event', async () => {
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(4)

    const result = await invokeHandler(guidebookBillingCreditHandler, {
      event: creditEvent(),
      step:  makeStep(),
    })

    expect(stripe.invoiceItems.create).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ skipped: true, reason: 'below_credit_threshold', activeSponsorCount: 4 })
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
})
