import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))
vi.mock('@/lib/stripe/client', () => ({
  PLANS: {
    starter: { name: 'Starter' },
    growth:  { name: 'Growth' },
  },
}))

import { notifyPlanChanged } from '@/lib/inngest/functions/notify-plan-changed'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
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
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyPlanChanged, {
      event: subscriptionUpdatedEvent({ plan: 'growth', previous_plan: 'starter' }),
      step:  makeStep(),
    })

    expect(result).toEqual({ notified: true, org_id: 'org_1', plan: 'growth', previous_plan: 'starter' })
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
