import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/stripe/client', () => ({
  PLANS: {
    starter: { name: 'Starter', maxProperties: 15 },
    growth:  { name: 'Growth',  maxProperties: 40 },
  },
  // Only 'price_growth_monthly' is one of OUR plan prices. Anything else —
  // a guidebook sponsor price, say — resolves to null, which is what lets the
  // handler tell "core billing subscription we cannot resolve yet" apart from
  // "not a core billing subscription at all".
  getPlanByPriceId: vi.fn((priceId: string) =>
    priceId === 'price_growth_monthly' ? 'growth' : null),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('@/lib/audit',            () => ({ logAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/helpers',  () => ({ getPmMembers: vi.fn(async () => []) }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { handleCoreSubscriptionUpdate } from '@/app/api/webhooks/stripe/handlers/core-billing'
import type { StripeSupabaseClient } from '@/app/api/webhooks/stripe/handlers/types'
import type Stripe from 'stripe'

/**
 * Chainable Supabase mock. Each table gets a QUEUE of results so the two
 * different organizations reads (by metadata id, then by customer id) can be
 * answered independently — which is the whole point of these tests.
 *
 * The entitlement WRITE goes through update_organization_subscription_from_stripe
 * (one transaction: lookup, row lock, read old plan, write), so `rpc` is what
 * these tests assert the write against. Resolution still runs first and is
 * what they actually exercise — the RPC only writes; it never decides which
 * org was found.
 */
function makeSupabase(
  queued: Record<string, { data?: unknown; error?: unknown }[]>,
  rpcResult: { data: unknown; error?: unknown } = {
    data: { org_id: 'org_1', org_name: 'Lake Martin', previous_plan: 'starter' },
    error: null,
  },
) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const rpc = vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve(rpcResult)) }))

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const m of ['select', 'insert', 'update', 'eq', 'is', 'in', 'not']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }
    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      resolveNext().then(res, rej)
    return chain
  })

  return { from, rpc, auth: { admin: { getUserById: vi.fn(async () => ({ data: null })) } }, calls }
}

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id:         'sub_1',
  customer:   'cus_1',
  status:     'trialing',
  trial_end:  null,
  metadata:   {},
  items:      { data: [{ price: { id: 'price_growth_monthly' } }] },
  ...overrides,
}) as unknown as Stripe.Subscription

const run = (supabase: ReturnType<typeof makeSupabase>, sub: Stripe.Subscription) =>
  handleCoreSubscriptionUpdate(
    supabase as unknown as StripeSupabaseClient,
    sub,
    'customer.subscription.created',
    undefined,
  )

describe('handleCoreSubscriptionUpdate — org resolution', () => {
  beforeEach(() => vi.clearAllMocks())

  // THE RACE. Stripe does not guarantee that checkout.session.completed (which
  // writes organizations.stripe_customer_id) arrives before
  // customer.subscription.created. When it doesn't, resolving the org by
  // customer id alone found nothing — and the handler returned silently with a
  // 200, so Stripe never retried. The customer had paid and had no plan,
  // max_properties or trial_ends_at at all.
  it('resolves the org from subscription metadata when the customer link does not exist yet', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: { id: 'org_1', name: 'Lake Martin' }, error: null }, // by metadata id
        { data: null, error: null },                                 // backfill update
        { data: null, error: null },                                 // entitlement update
      ],
    })

    await run(supabase, subscription({ metadata: { org_id: 'org_1' } }))

    // Resolution must have gone through the METADATA id. Asserting only on the
    // resulting update would pass against the old customer-id-only code too,
    // since both paths end in the same write — and asserting eq('id','org_1')
    // is no better, because the entitlement UPDATE filters on exactly that.
    // What actually discriminates: when metadata resolves the org, the
    // customer-id lookup never runs at all.
    const customerLookup = supabase.calls.some(
      (c) => c.table === 'organizations' && c.method === 'eq' && c.args[0] === 'stripe_customer_id',
    )
    expect(customerLookup).toBe(false)

    expect(supabase.rpc).toHaveBeenCalledWith(
      'update_organization_subscription_from_stripe',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_1',
        p_plan:                   'growth',
        p_plan_status:            'trialing',
        p_max_properties:         40,
      }),
    )
  })

  it('backfills stripe_customer_id when the org was found via metadata', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: { id: 'org_1', name: 'Lake Martin' }, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
    })

    await run(supabase, subscription({ metadata: { org_id: 'org_1' } }))

    const backfill = supabase.calls.find(
      (c) => c.table === 'organizations' && c.method === 'update'
        && (c.args[0] as Record<string, unknown>).stripe_customer_id === 'cus_1',
    )
    expect(backfill).toBeDefined()
  })

  // Subscriptions created before subscription_data.metadata shipped, and any
  // created outside the checkout flow, carry no org_id.
  it('falls back to the stripe_customer_id lookup when metadata carries no org_id', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: { id: 'org_2', name: 'Legacy Org' }, error: null }, // by customer id
        { data: null, error: null },
      ],
    })

    await run(supabase, subscription())

    const customerLookup = supabase.calls.some(
      (c) => c.table === 'organizations' && c.method === 'eq' && c.args[0] === 'stripe_customer_id',
    )
    expect(customerLookup, 'the customer-id lookup is the whole point of this path').toBe(true)
    expect(supabase.rpc).toHaveBeenCalled()
  })

  // The fix's teeth: an unresolvable org for one of OUR plans must retry, not
  // return 200. The route releases the dedup claim on a throw, so Stripe gets
  // a real second attempt once checkout.session.completed has landed.
  it('throws when the price is one of our plans but no org can be resolved', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    })

    await expect(run(supabase, subscription())).rejects.toThrow(/no resolvable org/)
  })

  // ...but a subscription that is not core billing at all (a guidebook sponsor,
  // whose customer is a sponsor rather than an org) legitimately has no org and
  // must NOT retry forever.
  it('returns quietly for a non-core-billing price with no org', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    })

    await expect(
      run(supabase, subscription({ items: { data: [{ price: { id: 'price_sponsor_slot' } }] } })),
    ).resolves.toBeUndefined()

    expect(supabase.calls.some((c) => c.table === 'organizations' && c.method === 'update')).toBe(false)
  })

  // A failed READ must not collapse into "no org" — that is the same silent
  // failure in a different disguise, and it would drop a paid customer's
  // entitlement on a transient DB blip while answering Stripe 200.
  it('throws when the org lookup itself errors rather than treating it as absent', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: null, error: { message: 'connection reset', code: '57P01' } },
      ],
    })

    await expect(
      run(supabase, subscription({ metadata: { org_id: 'org_1' } })),
    ).rejects.toThrow(/org lookup \(id\) failed/)
  })
})
