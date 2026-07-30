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

function makeSupabase(orgResult: { data: unknown; error?: unknown } = { data: { id: 'org_1', name: 'Lake Martin Delivery', plan: 'starter' }, error: null }) {
  const updateEq = vi.fn(() => Promise.resolve({ error: null }))
  const from = vi.fn((table: string) => {
    if (table === 'organizations') {
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve(orgResult)) })) })),
        update: vi.fn(() => ({ eq: updateEq })),
      }
    }
    if (table === 'organization_members') {
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: null, error: null })) })) })) })) }
    }
    throw new Error(`Unexpected table in test: ${table}`)
  })
  return { from } as never
}

describe('handleCoreSubscriptionUpdate — previous_plan enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('includes the org\'s pre-update plan as previous_plan on a genuine tier change (update event)', async () => {
    const supabase = makeSupabase({ data: { id: 'org_1', name: 'Lake Martin Delivery', plan: 'starter' }, error: null })

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
    const supabase = makeSupabase({ data: { id: 'org_1', name: 'Lake Martin Delivery', plan: 'starter' }, error: null })

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
    const supabase = makeSupabase({ data: { id: 'org_1', name: 'Lake Martin Delivery', plan: 'growth' }, error: null })

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
})
