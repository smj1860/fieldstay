import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  MAX_SELF_SERVE_PROPERTIES: 100,
  isPlatformPriceId: (priceId: string) => priceId === 'price_platform_monthly',
}))

import { handleCoreSubscriptionUpdate } from '@/app/api/webhooks/stripe/handlers/core-billing'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'

function makeSubscription(overrides: Partial<{
  id: string
  customer: string
  status: string
  priceId: string
  trialEnd: number | null
}> = {}) {
  const opts = { id: 'sub_1', customer: 'cus_1', status: 'active', priceId: 'price_platform_monthly', trialEnd: null, ...overrides }
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
//      lock, read-old-plan and write in one transaction.
//
// rpcResult is the DB function's RETURNS TABLE row — { org_id, org_name,
// previous_plan, applied } — or null/error for "no matching org" / an RPC
// failure. previous_plan is still returned by the RPC (it's a generic
// pre-update snapshot) but the handler no longer reads it — every self-serve
// org is 'platform' before and after, so there is no tier transition left to
// report. orgRow is what the `organizations` read resolves to.
function makeSupabase(
  rpcResult: { data: unknown; error?: unknown } = {
    data: { org_id: 'org_1', org_name: 'Lake Martin Delivery', previous_plan: 'platform', applied: true },
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
      // first-payment emails are a no-op path here.
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

// Stripe `event.created`, seconds. Threaded into the RPC's stale-delivery
// guard — an event older than the last one applied to the org is rejected.
const EVENT_CREATED = Math.floor(Date.parse('2026-08-04T12:00:00Z') / 1000)

describe('handleCoreSubscriptionUpdate — graduated platform pricing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls the atomic RPC with plan "platform" and the self-serve ceiling as max_properties', async () => {
    const supabase = makeSupabase()

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'active', priceId: 'price_platform_monthly', trialEnd: null }),
      'customer.subscription.updated',
      'active',
      EVENT_CREATED
    )

    expect((supabase as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      'update_organization_subscription_from_stripe',
      {
        p_customer_id:            'cus_1',
        p_stripe_subscription_id: 'sub_1',
        p_plan:                   'platform',
        p_plan_status:            'active',
        p_max_properties:         100,
        p_trial_ends_at:          null,
        p_event_at:               new Date(EVENT_CREATED * 1000).toISOString(),
      },
    )
  })

  it('logs the audit event with plan "platform" on a successful update', async () => {
    const supabase = makeSupabase()

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'active', priceId: 'price_platform_monthly' }),
      'customer.subscription.updated',
      'active',
      EVENT_CREATED
    )

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:  'org_1',
        action: 'billing.subscription.updated',
        metadata: expect.objectContaining({ plan: 'platform', planStatus: 'active' }),
      }),
    )
  })

  it('no longer sends a billing/subscription-updated event — retired with notify-plan-changed', async () => {
    const supabase = makeSupabase()

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'active', priceId: 'price_platform_monthly' }),
      'customer.subscription.updated',
      'active',
      EVENT_CREATED
    )

    expect(inngest.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'billing/subscription-updated' }),
    )
  })

  it('still entitles the org at plan "platform" / max_properties 100 when the RPC misses but the org WAS resolved', async () => {
    // The RPC keys on stripe_customer_id; resolveSubscriptionOrg can reach an
    // org by metadata that the RPC's lookup does not find (an org already
    // carrying a different customer id, where the backfill deliberately
    // no-ops). Returning on that miss would re-open the silent entitlement
    // drop the metadata resolution exists to fix, so it falls back to a
    // direct scoped write.
    const supabase = makeSupabase({ data: null, error: null })

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription(),
      'customer.subscription.updated',
      'active',
      EVENT_CREATED
    )

    expect((supabase as unknown as { orgUpdate: ReturnType<typeof vi.fn> }).orgUpdate)
      .toHaveBeenCalledWith(expect.objectContaining({ plan: 'platform', max_properties: 100 }))
  })

  it('is a no-op (no write, no audit log) for a subscription that is not core billing at all', async () => {
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
      EVENT_CREATED
    )

    expect(logAuditEvent).not.toHaveBeenCalled()
    expect((supabase as unknown as { orgUpdate: ReturnType<typeof vi.fn> }).orgUpdate).not.toHaveBeenCalled()
  })

  it('syncs only plan_status (never plan/max_properties) for a recognized-but-not-platform price, e.g. Enterprise', async () => {
    // isCoreBillingSubscription already filtered to core billing, but the
    // price is not our graduated self-serve price — an Enterprise contract
    // price, a promo, or a grandfathered one. Writing MAX_SELF_SERVE_PROPERTIES
    // over an Enterprise org's real (larger) cap would be a regression.
    const supabase = makeSupabase(
      undefined,
      { data: { id: 'org_1', name: 'Big Portfolio Co' }, error: null },
    )

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ priceId: 'price_enterprise_custom', status: 'active' }),
      'customer.subscription.updated',
      'active',
      EVENT_CREATED
    )

    const orgUpdate = (supabase as unknown as { orgUpdate: ReturnType<typeof vi.fn> }).orgUpdate
    expect(orgUpdate).toHaveBeenCalledWith({ plan_status: 'active' })
    expect(orgUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ plan: expect.anything() }))
    expect(orgUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ max_properties: expect.anything() }))
  })

  it('throws when the RPC itself errors, instead of silently proceeding with no org', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'row lock timeout' } })

    await expect(
      handleCoreSubscriptionUpdate(supabase, makeSubscription(), 'customer.subscription.updated', 'active', EVENT_CREATED),
    ).rejects.toThrow('row lock timeout')

    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})

// ── Stale delivery ──────────────────────────────────────────────────────────
//
// The FOR UPDATE row lock orders CONCURRENT deliveries; it cannot tell a newer
// event from an older one. Stripe does not guarantee order and retries for ~3
// days, so a delayed trialing->active retry could land after a later
// active->past_due and hand entitlement back on a failed card. The RPC now
// rejects an event older than the last one applied and reports applied: false.
describe('handleCoreSubscriptionUpdate — stale delivery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires no audit row or email when the RPC reports the delivery was stale', async () => {
    const supabase = makeSupabase({
      data: { org_id: 'org_1', org_name: 'Lake Martin Delivery', previous_plan: 'platform', applied: false },
      error: null,
    })

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'trialing', priceId: 'price_platform_monthly', trialEnd: 1234567890 }),
      'customer.subscription.created',
      undefined,
      EVENT_CREATED,
    )

    // Nothing was written, so nothing downstream may describe a transition:
    // announcing a trial start again is worse than the silent skip.
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('passes the event timestamp through so the RPC can make that decision', async () => {
    const supabase = makeSupabase()

    await handleCoreSubscriptionUpdate(
      supabase,
      makeSubscription({ status: 'active', priceId: 'price_platform_monthly' }),
      'customer.subscription.updated',
      'active',
      EVENT_CREATED,
    )

    expect((supabase as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      'update_organization_subscription_from_stripe',
      expect.objectContaining({
        p_event_at: new Date(EVENT_CREATED * 1000).toISOString(),
      }),
    )
  })
})
