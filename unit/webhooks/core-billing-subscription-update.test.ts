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

// Mocks the RPC-based lookup+update (update_organization_subscription_from_stripe)
// that replaced the old separate select()+update() pair — see the TOCTOU race
// fix in core-billing.ts. rpcResult is what the DB function's RETURNS TABLE
// row would look like: { org_id, org_name, previous_plan }, or null/error to
// simulate "no matching org" / an RPC failure.
function makeSupabase(rpcResult: { data: unknown; error?: unknown } = {
  data: { org_id: 'org_1', org_name: 'Lake Martin Delivery', previous_plan: 'starter' },
  error: null,
}) {
  const rpc = vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve(rpcResult)) }))
  const from = vi.fn((table: string) => {
    if (table === 'organization_members') {
      // getPmMembers()/getPmMembersByOrgIds() (lib/inngest/helpers.ts) query
      // shape: .select().in('org_id',...).in('role',...).not('invite_accepted_at',...).
      // No PM members needed for these tests — notifyOrgAdmin's trial-start/
      // first-payment emails are a no-op path here, only previous_plan
      // enrichment via the RPC result is under test.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.select = vi.fn(() => chain)
      chain.in     = vi.fn(() => chain)
      chain.not    = vi.fn(() => Promise.resolve({ data: [], error: null }))
      return chain
    }
    throw new Error(`Unexpected table in test: ${table}`)
  })
  return { rpc, from } as never
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

  it('is a no-op (no event sent) when the RPC finds no matching org', async () => {
    const supabase = makeSupabase({ data: null, error: null })

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription(),
      'customer.subscription.updated',
      'active',
    )

    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('throws when the RPC itself errors, instead of silently proceeding with no org', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'row lock timeout' } })

    await expect(
      handleCoreSubscriptionUpdate(supabase, makeSubscription(), 'customer.subscription.updated', 'active'),
    ).rejects.toThrow('row lock timeout')

    expect(inngest.send).not.toHaveBeenCalled()
  })
})
