import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { subscriptions: { retrieve: vi.fn() } },
}))
vi.mock('@/lib/guidebook/helpers', () => ({
  getActiveSponsorCount: vi.fn(),
}))

import { guidebookDailyMonitor } from '@/lib/inngest/functions/guidebook-daily-monitor'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { inngest } from '@/lib/inngest/client'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and cron-vendor-compliance-grace-check.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.update = (...a: unknown[]) => record('update', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

// Real Inngest step.run is not memoized here — matches every other cron test
// in this batch. step.run bodies in this function run inside Promise.all, so
// the stub just needs to execute the callback and return its result.
function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function configRow(overrides: Record<string, unknown> = {}) {
  return {
    org_id:                'org_1',
    grace_period_ends_at:  null,
    trial_ends_at:         null,
    organizations:         { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' },
    ...overrides,
  }
}

describe('guidebookDailyMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('dispatches a billing-credit event for an org renewing within 48 hours with >= 5 active sponsors, plus a grace-period-expired event for another org', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [
        {
          data: [
            configRow(),
            configRow({ org_id: 'org_2', organizations: { stripe_customer_id: null, stripe_subscription_id: null }, grace_period_ends_at: '2026-07-21T00:00:00.000Z' }),
          ],
          error: null,
        },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const periodEndUnix = Math.floor(new Date('2026-07-23T00:00:00.000Z').getTime() / 1000) // 24h from now
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({ current_period_end: periodEndUnix })
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(5)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookDailyMonitor, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ evaluated: 2, dispatched: 2 })
    expect(sendSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'guidebook/billing.credit.evaluate',
        data: { orgId: 'org_1', stripeCustomerId: 'cus_1', currentPeriodEnd: periodEndUnix },
      }),
      expect.objectContaining({
        name: 'guidebook/grace.period.expired',
        data: { orgId: 'org_2' },
      }),
    ])
  })

  it('is a no-op when the renewal is more than 48 hours away — checks Stripe but never counts sponsors or dispatches', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: [configRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const farPeriodEndUnix = Math.floor(new Date('2026-07-26T00:00:00.000Z').getTime() / 1000) // 96h away
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({ current_period_end: farPeriodEndUnix })
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookDailyMonitor, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ evaluated: 1, dispatched: 0 })
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1')
    expect(getActiveSponsorCount).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('does not dispatch a billing credit for an org with fewer than 5 active sponsors even when renewal is imminent', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: [configRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const periodEndUnix = Math.floor(new Date('2026-07-23T00:00:00.000Z').getTime() / 1000)
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({ current_period_end: periodEndUnix })
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(4)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookDailyMonitor, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ evaluated: 1, dispatched: 0 })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('skips the Stripe lookup entirely for an org missing a subscription or customer id', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{
        data: [configRow({ organizations: { stripe_customer_id: null, stripe_subscription_id: null } })],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookDailyMonitor, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ evaluated: 1, dispatched: 0 })
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('locks a guidebook whose trial expired overnight and still has fewer than 3 active sponsors', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{
        data: [configRow({
          organizations: { stripe_customer_id: null, stripe_subscription_id: null },
          trial_ends_at: '2026-07-20T00:00:00.000Z',
        })],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)
    vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    await invokeHandler(guidebookDailyMonitor, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    const updateCall = supabase.calls.find((c) => c.table === 'guidebook_configurations' && c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({ is_active: false })
  })

  it('does not lock a guidebook whose trial expired but already has >= 3 active sponsors', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{
        data: [configRow({
          organizations: { stripe_customer_id: null, stripe_subscription_id: null },
          trial_ends_at: '2026-07-20T00:00:00.000Z',
        })],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(3)
    vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    await invokeHandler(guidebookDailyMonitor, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(supabase.calls.some((c) => c.table === 'guidebook_configurations' && c.method === 'update')).toBe(false)
  })
})
