import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    subscriptions: {
      retrieve: vi.fn(),
      update:   vi.fn(),
    },
  },
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import {
  billingPropertyReconciliation,
  reconcilePropertyCountForOrg,
  ANNUAL_PRORATION_ADDITION_THRESHOLD,
} from '@/lib/inngest/functions/cron/billing-property-reconciliation'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { createPmNotification } from '@/lib/inngest/helpers'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown; count?: number }[]>) {
  const counters: Record<string, number> = {}

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'in', 'not', 'order', 'range']) {
      chain[m] = () => chain
    }
    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from }
}

function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(),
  }
}

function makeSubscription(overrides: {
  itemId?: string
  quantity?: number
  interval?: 'month' | 'year'
} = {}) {
  const { itemId = 'si_1', quantity = 4, interval = 'month' } = overrides
  return {
    items: {
      data: [{ id: itemId, quantity, price: { recurring: { interval } } }],
    },
  }
}

describe('billingPropertyReconciliation (cron fan-out)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dispatches one event per candidate org', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: [{ id: 'org_1' }, { id: 'org_2' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(billingPropertyReconciliation, {
      event: {}, step, logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-property-reconciliation', [
      { name: 'billing/reconcile-property-count.requested', data: { org_id: 'org_1' } },
      { name: 'billing/reconcile-property-count.requested', data: { org_id: 'org_2' } },
    ])
  })

  it('dispatches nothing when there are no candidate orgs', async () => {
    const supabase = makeSupabase({ organizations: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(billingPropertyReconciliation, {
      event: {}, step, logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})

describe('reconcilePropertyCountForOrg — per-org handler', () => {
  beforeEach(() => vi.clearAllMocks())

  function run(orgId: string, supabase: ReturnType<typeof makeSupabase>) {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    return invokeHandler(reconcilePropertyCountForOrg, {
      event: { data: { org_id: orgId } },
      step:  makeStep(),
    })
  }

  it('is a no-op when the live count already matches the billed quantity', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
      properties:    [{ data: null, error: null, count: 4 }],
    })
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue(makeSubscription({ quantity: 4 }))

    await run('org_1', supabase)

    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it('is a no-op when the org has no stripe_subscription_id', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { stripe_subscription_id: null }, error: null }],
    })

    await run('org_1', supabase)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it('is a no-op when the live property count is zero', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
      properties:    [{ data: null, error: null, count: 0 }],
    })

    await run('org_1', supabase)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it('reports and skips when the subscription has no line item', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
      properties:    [{ data: null, error: null, count: 5 }],
    })
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({ items: { data: [] } })

    await run('org_1', supabase)

    expect(reportError).toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  describe('monthly billing', () => {
    it('applies an INCREASE with proration_behavior none, deferred to the next invoice', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
        properties:    [{ data: null, error: null, count: 6 }],
      })
      ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeSubscription({ quantity: 4, interval: 'month' }))

      await run('org_1', supabase)

      expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items:              [{ id: 'si_1', quantity: 6 }],
        proration_behavior: 'none',
      })
    })

    it('applies a DECREASE with proration_behavior none too', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
        properties:    [{ data: null, error: null, count: 2 }],
      })
      ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeSubscription({ quantity: 4, interval: 'month' }))

      await run('org_1', supabase)

      expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items:              [{ id: 'si_1', quantity: 2 }],
        proration_behavior: 'none',
      })
    })

    it('never fires the annual proration notification', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
        properties:    [{ data: null, error: null, count: 20 }],
      })
      ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeSubscription({ quantity: 4, interval: 'month' }))

      await run('org_1', supabase)

      expect(createPmNotification).not.toHaveBeenCalled()
      expect(logAuditEvent).not.toHaveBeenCalled()
    })
  })

  describe('annual billing', () => {
    it('applies a DECREASE immediately with proration_behavior none', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
        properties:    [{ data: null, error: null, count: 3 }],
      })
      ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeSubscription({ quantity: 4, interval: 'year' }))

      await run('org_1', supabase)

      expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items:              [{ id: 'si_1', quantity: 3 }],
        proration_behavior: 'none',
      })
    })

    it('HOLDS an increase below the addition threshold — no Stripe call at all', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
        // 4 pending additions, one short of the threshold
        properties:    [{ data: null, error: null, count: 4 + ANNUAL_PRORATION_ADDITION_THRESHOLD - 1 }],
      })
      ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeSubscription({ quantity: 4, interval: 'year' }))

      await run('org_1', supabase)

      expect(stripe.subscriptions.update).not.toHaveBeenCalled()
      expect(createPmNotification).not.toHaveBeenCalled()
    })

    it('FLUSHES the whole pending delta once the addition threshold is reached, with create_prorations', async () => {
      const billedQuantity = 4
      const newQuantity = billedQuantity + ANNUAL_PRORATION_ADDITION_THRESHOLD
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
        properties:    [{ data: null, error: null, count: newQuantity }],
      })
      ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeSubscription({ quantity: billedQuantity, interval: 'year' }))

      await run('org_1', supabase)

      expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items:              [{ id: 'si_1', quantity: newQuantity }],
        proration_behavior: 'create_prorations',
      })
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId:  'org_1',
          action: 'billing.subscription.quantity_prorated',
          metadata: expect.objectContaining({
            previousQuantity: billedQuantity, newQuantity, pendingAdditions: ANNUAL_PRORATION_ADDITION_THRESHOLD,
          }),
        }),
      )
      expect(createPmNotification).toHaveBeenCalledWith(supabase, expect.objectContaining({
        orgId:     'org_1',
        type:      'billing_quantity_updated',
        dedupeKey: `billing-quantity-flush-org_1-${billedQuantity}-${newQuantity}`,
      }))
    })

    it('flushes MORE than the threshold in one shot if the gap already exceeds it (e.g. a delayed run)', async () => {
      const billedQuantity = 4
      const newQuantity = billedQuantity + ANNUAL_PRORATION_ADDITION_THRESHOLD + 3
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
        properties:    [{ data: null, error: null, count: newQuantity }],
      })
      ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeSubscription({ quantity: billedQuantity, interval: 'year' }))

      await run('org_1', supabase)

      expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items:              [{ id: 'si_1', quantity: newQuantity }],
        proration_behavior: 'create_prorations',
      })
    })

    it('is naturally idempotent: re-running after a successful flush is a no-op (Stripe already reflects it)', async () => {
      // Simulates a step retry after the update actually succeeded — the
      // re-fetched subscription already shows the new quantity, so the
      // second pass sees no delta at all and does nothing further.
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
        properties:    [{ data: null, error: null, count: 9 }],
      })
      ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
        .mockResolvedValue(makeSubscription({ quantity: 9, interval: 'year' }))

      await run('org_1', supabase)

      expect(stripe.subscriptions.update).not.toHaveBeenCalled()
      expect(createPmNotification).not.toHaveBeenCalled()
    })
  })
})
