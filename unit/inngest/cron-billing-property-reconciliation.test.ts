import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
const PLATFORM_PRICE_ID = 'price_platform_test'
vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    subscriptions: {
      retrieve: vi.fn(),
      update:   vi.fn(),
    },
  },
  isPlatformPriceId: (id: string) => id === PLATFORM_PRICE_ID,
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
  itemId?:  string
  quantity?: number
  interval?: 'month' | 'year'
  priceId?:  string
} = {}) {
  const { itemId = 'si_1', quantity = 4, interval = 'month', priceId = PLATFORM_PRICE_ID } = overrides
  return {
    items: {
      data: [{ id: itemId, quantity, price: { id: priceId, recurring: { interval } } }],
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
    // sendEventsChunked names each chunk's step `${prefix}-${i}` so Inngest
    // can memoize per chunk — one chunk here, hence the `-0` suffix.
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-property-reconciliation-0', [
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

  it('reports and skips when the subscription has no line item at all', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
      properties:    [{ data: null, error: null, count: 5 }],
    })
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({ items: { data: [] } })

    await run('org_1', supabase)

    expect(reportError).toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  // ── Regression: don't mutate a price that isn't the platform price ──────
  // `organizations.plan` is display-only and only ever synced FORWARD by the
  // Stripe webhook, so it can still read 'platform' for an org whose live
  // subscription has since moved to Enterprise, a promo, or a grandfathered
  // price — this dispatcher's own `.eq('plan', 'platform')` filter can let
  // exactly such an org through. That price's `quantity` means something
  // else, or nothing at all; writing this org's live property count into it
  // is a silent, unrelated billing change, not a reconciliation.

  it('does NOT mutate an item whose price is not the platform price, quietly (no report)', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
      properties:    [{ data: null, error: null, count: 5 }],
    })
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>)
      .mockResolvedValue(makeSubscription({ priceId: 'price_enterprise_custom' }))

    await run('org_1', supabase)

    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    // Expected, benign divergence — not worth an alert.
    expect(reportError).not.toHaveBeenCalled()
  })

  it('finds the platform-price item even when an add-on line sits at position 0', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { stripe_subscription_id: 'sub_1' }, error: null }],
      properties:    [{ data: null, error: null, count: 6 }],
    })
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: {
        data: [
          { id: 'si_addon',    quantity: 1, price: { id: 'price_addon', recurring: { interval: 'month' } } },
          { id: 'si_platform', quantity: 4, price: { id: PLATFORM_PRICE_ID, recurring: { interval: 'month' } } },
        ],
      },
    })

    await run('org_1', supabase)

    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      items:              [{ id: 'si_platform', quantity: 6 }],
      proration_behavior: 'none',
    }, expect.anything())
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
      }, { idempotencyKey: 'billing-reconcile:org_1:sub_1:6:none' })
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
      }, { idempotencyKey: 'billing-reconcile:org_1:sub_1:2:none' })
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
      }, { idempotencyKey: 'billing-reconcile:org_1:sub_1:3:none' })
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
      }, { idempotencyKey: `billing-reconcile:org_1:sub_1:${newQuantity}:create_prorations` })
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
      }, { idempotencyKey: `billing-reconcile:org_1:sub_1:${newQuantity}:create_prorations` })
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

  it('serialises per org, so two live invocations for the same org cannot race a stale Stripe read', () => {
    // Sequential-retry idempotency ("re-fetch fresh from Stripe") says
    // nothing about two CONCURRENT invocations — the dispatcher's own
    // step.sendEvent() can itself be retried and re-send a second event for
    // the same org. Without a per-org key, both invocations read the same
    // stale billedQuantity before either writes: a TOCTOU race on real
    // billing state. Asserted on the function's config, the same pattern
    // used for auto-assign-turnover's per-turnover lock, because the
    // guarantee IS the config — Inngest enforces it, and there's nothing in
    // this process to observe directly.
    const concurrency = (reconcilePropertyCountForOrg as unknown as {
      opts: { concurrency: Array<{ limit: number; key?: string }> }
    }).opts.concurrency

    expect(Array.isArray(concurrency)).toBe(true)
    expect(concurrency).toContainEqual({ limit: 1, key: 'event.data.org_id' })
    // …without giving up the global cap that keeps a bulk fan-out from
    // exhausting Stripe-side throughput — 30, not this codebase's usual
    // per-org-fan-out { limit: 10 }, since this cron's per-org work is a
    // Stripe round trip rather than a Supabase-connection-pool-bound one.
    expect(concurrency).toContainEqual({ limit: 30 })
  })
})
