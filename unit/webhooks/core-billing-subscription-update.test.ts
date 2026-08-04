import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  PLANS: {
    starter:  { name: 'Starter',  maxProperties: 15 },
    growth:   { name: 'Growth',   maxProperties: 50 },
  },
  getPlanByPriceId: (priceId: string) =>
    priceId === 'price_growth' ? 'growth' : priceId === 'price_starter' ? 'starter' : null,
}))

import { handleCoreSubscriptionUpdate } from '@/app/api/webhooks/stripe/handlers/core-billing'
import { inngest } from '@/lib/inngest/client'

function makeSubscription(overrides: Partial<{
  id: string
  customer: string
  status: string
  priceId: string
  trialEnd: number | null
}> = {}) {
  const opts = { id: 'sub_1', customer: 'cus_1', status: 'active', priceId: 'price_growth', trialEnd: null, ...overrides }
  return {
    id:       opts.id,
    customer: opts.customer,
    status:   opts.status,
    items:    { data: [{ price: { id: opts.priceId } }] },
    trial_end: opts.trialEnd,
  } as never
}

// The handler does TWO things to the database, and the double has to answer
// both — they arrived from opposite sides of a merge:
//
//   1. resolveSubscriptionOrg() reads `organizations` (metadata id first,
//      stripe_customer_id second) so a first-time subscriber whose customer
//      link is not written yet still gets entitled.
//   2. update_organization_subscription_from_stripe() does the lookup, row
//      lock, read-old-plan and write in one transaction, closing the TOCTOU
//      race on previous_plan.
//
// rpcResult is the DB function's RETURNS TABLE row — { org_id, org_name,
// previous_plan } — or null/error for "no matching org" / an RPC failure.
// orgRow is what the `organizations` read resolves to.
function makeSupabase(
  rpcResult: { data: unknown; error?: unknown } = {
    data: { org_id: 'org_1', org_name: 'Lake Martin Delivery', previous_plan: 'starter' },
    error: null,
  },
  orgRow: { data: unknown; error?: unknown } = {
    data: { id: 'org_1', name: 'Lake Martin Delivery' },
    error: null,
  },
) {
  const rpc = vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve(rpcResult)) }))
  const orgUpdate = vi.fn()

  const from = vi.fn((table: string) => {
    if (table === 'organization_members') {
      // getPmMembers()/getPmMembersByOrgIds() (lib/inngest/helpers.ts) query
      // shape: .select().in('org_id',...).in('role',...).not('invite_accepted_at',...)
      // .order('org_id').range(from, to) — it is paginated through
      // fetchAllRows(), so the chain has to run all the way to .range().
      // No PM members needed for these tests — notifyOrgAdmin's trial-start/
      // first-payment emails are a no-op path here, only previous_plan
      // enrichment via the RPC result is under test.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.select = vi.fn(() => chain)
      chain.in     = vi.fn(() => chain)
      chain.not    = vi.fn(() => chain)
      chain.order  = vi.fn(() => chain)
      chain.range  = vi.fn(() => Promise.resolve({ data: [], error: null }))
      return chain
    }
    if (table === 'organizations') {
      // Two shapes on one table: the resolve READ ends in .maybeSingle(),
      // the fallback WRITE ends by being awaited after .eq().
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.select      = vi.fn(() => chain)
      chain.update      = vi.fn((payload: unknown) => { orgUpdate(payload); return chain })
      chain.eq          = vi.fn(() => chain)
      chain.is          = vi.fn(() => chain)
      chain.maybeSingle = vi.fn(() => Promise.resolve(orgRow))
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return chain
    }
    throw new Error(`Unexpected table in test: ${table}`)
  })
  return { rpc, from, orgUpdate } as never
}

describe('handleCoreSubscriptionUpdate — previous_plan enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls the atomic RPC with the mapped plan/status/max_properties/trial_ends_at', async () => {
    const supabase = makeSupabase()

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'active', priceId: 'price_growth', trialEnd: null }),
      'customer.subscription.updated',
      'active',
    )

    expect((supabase as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      'update_organization_subscription_from_stripe',
      {
        p_customer_id:            'cus_1',
        p_stripe_subscription_id: 'sub_1',
        p_plan:                   'growth',
        p_plan_status:            'active',
        p_max_properties:         50,
        p_trial_ends_at:          null,
      },
    )
  })

  it('includes the org\'s pre-update plan as previous_plan on a genuine tier change (update event)', async () => {
    const supabase = makeSupabase({
      data: { org_id: 'org_1', org_name: 'Lake Martin Delivery', previous_plan: 'starter' },
      error: null,
    })

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'active', priceId: 'price_growth' }),
      'customer.subscription.updated',
      'active',
    )

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'billing/subscription-updated',
      data: {
        org_id:                 'org_1',
        stripe_subscription_id: 'sub_1',
        plan:                   'growth',
        plan_status:            'active',
        previous_plan:          'starter',
      },
    })
  })

  it('always sends previous_plan: null on the initial subscription.created event, regardless of the org\'s stored plan', async () => {
    // Simulates an org whose DB default happens to differ from the tier
    // they signed up for — this must NOT be reported as a "plan change".
    const supabase = makeSupabase({
      data: { org_id: 'org_1', org_name: 'Lake Martin Delivery', previous_plan: 'starter' },
      error: null,
    })

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'trialing', priceId: 'price_growth', trialEnd: 1234567890 }),
      'customer.subscription.created',
      undefined,
    )

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'billing/subscription-updated',
        data: expect.objectContaining({ previous_plan: null }),
      }),
    )
  })

  it('reports previous_plan equal to the new plan when nothing actually changed tier (e.g. a status-only update)', async () => {
    const supabase = makeSupabase({
      data: { org_id: 'org_1', org_name: 'Lake Martin Delivery', previous_plan: 'growth' },
      error: null,
    })

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'active', priceId: 'price_growth' }),
      'customer.subscription.updated',
      'active',
    )

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ plan: 'growth', previous_plan: 'growth' }),
      }),
    )
  })

  it('still entitles the org when the RPC misses but the org WAS resolved', async () => {
    // The RPC keys on stripe_customer_id; resolveSubscriptionOrg can reach an
    // org by metadata that the RPC's lookup does not find (an org already
    // carrying a different customer id, where the backfill deliberately
    // no-ops). Returning on that miss would re-open the silent entitlement
    // drop the metadata resolution exists to fix, so it falls back to a
    // direct scoped write — and previous_plan is null, because no pre-update
    // plan was ever read under a lock.
    const supabase = makeSupabase({ data: null, error: null })

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription(),
      'customer.subscription.updated',
      'active',
    )

    expect((supabase as unknown as { orgUpdate: ReturnType<typeof vi.fn> }).orgUpdate)
      .toHaveBeenCalledWith(expect.objectContaining({ plan: 'growth', max_properties: 50 }))
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'billing/subscription-updated',
        data: expect.objectContaining({ org_id: 'org_1', previous_plan: null }),
      }),
    )
  })

  it('is a no-op (no event, no write) for a subscription that is not core billing at all', async () => {
    // Guidebook sponsor subscriptions land on this same webhook and their
    // customer is a sponsor, not an org. Those must not retry forever — the
    // price id is what tells them apart.
    const supabase = makeSupabase(
      { data: null, error: null },
      { data: null, error: null },
    )

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ priceId: 'price_sponsor_slot' }),
      'customer.subscription.updated',
      'active',
    )

    expect(inngest.send).not.toHaveBeenCalled()
    expect((supabase as unknown as { orgUpdate: ReturnType<typeof vi.fn> }).orgUpdate).not.toHaveBeenCalled()
  })

  it('throws when the RPC itself errors, instead of silently proceeding with no org', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'row lock timeout' } })

    await expect(
      handleCoreSubscriptionUpdate(supabase, makeSubscription(), 'customer.subscription.updated', 'active'),
    ).rejects.toThrow('row lock timeout')

    expect(inngest.send).not.toHaveBeenCalled()
  })
})
