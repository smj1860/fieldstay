import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))
vi.mock('@/lib/stripe/client', () => ({
  PLANS: {
    hosts:   { name: 'Hosts',   maxProperties: 4 },
    starter: { name: 'Starter', maxProperties: 15 },
    growth:  { name: 'Growth',  maxProperties: 50 },
  },
}))

import { notifyPlanChanged } from '@/lib/inngest/functions/notify-plan-changed'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

/**
 * The property-cap check issues a head+count read, so the client can no
 * longer be a bare `{}`. `count` is what the handler reads; `error` lets a
 * test drive the failure path.
 */
function makeSupabase(result: { count?: number | null; error?: unknown } = { count: 0, error: null }) {
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.eq     = () => chain
    chain.then   = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, count: result.count ?? null, error: result.error ?? null }).then(resolve)
    return chain
  })
  return { from }
}

function subscriptionUpdatedEvent(overrides: Partial<{ org_id: string; plan: string; previous_plan: string | null }> = {}) {
  return {
    data: {
      org_id:                 'org_1',
      stripe_subscription_id: 'sub_1',
      plan:                   'growth',
      plan_status:            'active',
      previous_plan:          'starter',
      ...overrides,
    },
  }
}

describe('notifyPlanChanged', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('notifies the PM with friendly plan names on a genuine tier change', async () => {
    const supabase = makeSupabase({ count: 3 })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyPlanChanged, {
      event: subscriptionUpdatedEvent({ plan: 'growth', previous_plan: 'starter' }),
      step:  makeStep(),
    })

    expect(result).toEqual({
      notified: true, org_id: 'org_1', plan: 'growth', previous_plan: 'starter', overCapacity: false,
    })
    expect(createPmNotification).toHaveBeenCalledWith(supabase, {
      orgId:     'org_1',
      type:      'billing_plan_changed',
      title:     'Your plan changed to Growth',
      subtitle:  'Previously Starter',
      href:      '/settings',
      severity:  'blue',
      dedupeKey: expect.stringMatching(/^plan-changed-org_1-starter-growth-\d{4}-\d{2}-\d{2}$/) as unknown as string,
    })
  })

  it('is a no-op when previous_plan is null (initial signup, not a tier change)', async () => {
    const result = await invokeHandler(notifyPlanChanged, {
      event: subscriptionUpdatedEvent({ previous_plan: null }),
      step:  makeStep(),
    })

    expect(result).toEqual({ notified: false, org_id: 'org_1', reason: 'no_tier_change' })
    expect(createPmNotification).not.toHaveBeenCalled()
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('is a no-op when previous_plan equals the new plan (no real tier change)', async () => {
    const result = await invokeHandler(notifyPlanChanged, {
      event: subscriptionUpdatedEvent({ plan: 'growth', previous_plan: 'growth' }),
      step:  makeStep(),
    })

    expect(result).toEqual({ notified: false, org_id: 'org_1', reason: 'no_tier_change' })
    expect(createPmNotification).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Over-capacity detection.
//
// createCheckoutSession refuses a plan that does not cover the org's existing
// properties — but it only guards OUR checkout, and it deliberately sends
// anyone with a live subscription to the Stripe billing portal, which is
// therefore where most plan changes actually happen. A downgrade made there is
// already committed by the time this event fires, so it can only be surfaced.
//
// Unsurfaced it is silent: max_properties is written straight from
// PLANS[plan].maxProperties, existing properties keep working (the cap is only
// enforced when ADDING one), and the org quietly pays for less than it uses.
// ============================================================================
describe('notifyPlanChanged — downgrade below the org\'s property count', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('raises a second, amber notification when the new plan covers fewer properties than the org has', async () => {
    const supabase = makeSupabase({ count: 10 })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyPlanChanged, {
      event: subscriptionUpdatedEvent({ plan: 'hosts', previous_plan: 'starter' }),
      step:  makeStep(),
    })

    expect(result).toMatchObject({ overCapacity: true })
    expect(createPmNotification).toHaveBeenCalledTimes(2)
    expect(createPmNotification).toHaveBeenLastCalledWith(supabase, expect.objectContaining({
      orgId:     'org_1',
      type:      'billing_plan_over_capacity',
      title:     'Hosts covers fewer properties than you have',
      subtitle:  expect.stringContaining('10 active properties'),
      severity:  'amber',
      // Keyed on the STATE (plan + count), not the day — a standing condition
      // re-notified daily would be nagging, but a further change is new state.
      dedupeKey: 'plan-over-cap-org_1-hosts-10',
    }))
  })

  it('does not raise it when the org fits exactly at the cap', async () => {
    // Boundary: 4 properties on a 4-property plan is COVERED, not over. The
    // add-property gate uses >= because it asks "can I fit one more"; this
    // asks "does this plan cover what I have", which is a different question.
    const supabase = makeSupabase({ count: 4 })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyPlanChanged, {
      event: subscriptionUpdatedEvent({ plan: 'hosts', previous_plan: 'starter' }),
      step:  makeStep(),
    })

    expect(result).toMatchObject({ overCapacity: false })
    expect(createPmNotification).toHaveBeenCalledTimes(1)
    expect(createPmNotification).not.toHaveBeenCalledWith(supabase, expect.objectContaining({
      type: 'billing_plan_over_capacity',
    }))
  })

  it('does not raise it on an UPGRADE that comfortably covers the org', async () => {
    const supabase = makeSupabase({ count: 30 })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyPlanChanged, {
      event: subscriptionUpdatedEvent({ plan: 'growth', previous_plan: 'starter' }),
      step:  makeStep(),
    })

    expect(result).toMatchObject({ overCapacity: false })
    expect(createPmNotification).toHaveBeenCalledTimes(1)
  })

  it('throws rather than reporting "fits fine" when the property count read errors', async () => {
    // A discarded error here would read as count 0, i.e. "comfortably within
    // cap" — the silent-success direction, and the exact class this audit has
    // been closing. unwrapCount throws so Inngest retries.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = makeSupabase({ count: null, error: { message: 'statement timeout', code: '57014' } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(notifyPlanChanged, {
        event: subscriptionUpdatedEvent({ plan: 'hosts', previous_plan: 'starter' }),
        step:  makeStep(),
      }),
    ).rejects.toThrow()
  })
})
