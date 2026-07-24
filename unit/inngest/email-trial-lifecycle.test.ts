import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/emails/trial-expiring', () => ({
  renderTrialExpiringEmail: vi.fn(async () => '<html>expiring</html>'),
}))
vi.mock('@/emails/trial-expired', () => ({
  renderTrialExpiredEmail: vi.fn(async () => '<html>expired</html>'),
}))

import { handleTrialLifecycle } from '@/lib/inngest/functions/email-trial-lifecycle'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderTrialExpiringEmail } from '@/emails/trial-expiring'
import { renderTrialExpiredEmail } from '@/emails/trial-expired'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order — mirrors checklist-broadcast.test.ts.
// `organizations` is queried once per subscription check (up to 3 times
// across the sequence).
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.eq     = () => chain

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then        = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from }
}

function makeStep() {
  return {
    run:        vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep:      vi.fn(async () => undefined),
    sleepUntil: vi.fn(async () => undefined),
  }
}

function trialEvent(overrides: Partial<{
  org_id: string; user_email: string; first_name: string; org_name: string; trial_ends_at: string
}> = {}) {
  return {
    data: {
      org_id:        'org_1',
      user_email:    'pm@example.com',
      first_name:    'Jamie',
      org_name:      'Lakeview Rentals',
      trial_ends_at: '2026-08-01T00:00:00.000Z',
      ...overrides,
    },
  }
}

const trialingOrg = { data: { plan_status: 'trialing' }, error: null }
const activeOrg    = { data: { plan_status: 'active' }, error: null }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
})

describe('handleTrialLifecycle', () => {
  it('runs the full sequence and sends all three emails when the org never subscribes', async () => {
    const supabase = makeSupabase({
      organizations: [trialingOrg, trialingOrg, trialingOrg],
      integration_connections: [{ data: { id: 'conn_1' }, error: null }],
      properties: [{ data: null, error: null, count: 4 } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(handleTrialLifecycle, {
      event: trialEvent(),
      step,
    })

    expect(result).toBeUndefined()
    expect(step.sleepUntil).toHaveBeenCalledTimes(2)
    expect(step.sleep).toHaveBeenCalledWith('sleep-before-churn-email', '3 days')

    expect(resend.emails.send).toHaveBeenCalledTimes(3)
    expect(resend.emails.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ to: 'pm@example.com', subject: 'Your FieldStay trial ends in 3 days' }),
      { idempotencyKey: 'trial-expiring-org_1' },
    )
    expect(resend.emails.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ subject: 'Your FieldStay trial has ended' }),
      { idempotencyKey: 'trial-expired-org_1' },
    )
    expect(resend.emails.send).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ subject: 'honest question' }),
      { idempotencyKey: 'trial-churn-feedback-org_1' },
    )

    expect(renderTrialExpiringEmail).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jamie', orgName: 'Lakeview Rentals', propertyCount: 4, ownerRezConnected: true }),
    )
  })

  it('cancels the whole sequence when the org already subscribed before the 3-day warning', async () => {
    const supabase = makeSupabase({
      organizations: [activeOrg],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(handleTrialLifecycle, {
      event: trialEvent(),
      step,
    })

    expect(result).toEqual({ cancelled: true, reason: 'subscribed-before-warning' })
    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(step.sleepUntil).toHaveBeenCalledTimes(1) // only the wait before the first check
  })

  it('sends the trial-expiring email but stops before trial-expired if they subscribe in between', async () => {
    const supabase = makeSupabase({
      organizations: [trialingOrg, activeOrg],
      integration_connections: [{ data: null, error: null }],
      properties: [{ data: null, error: null, count: null } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTrialLifecycle, {
      event: trialEvent(),
      step:  makeStep(),
    })

    expect(result).toEqual({ cancelled: true, reason: 'subscribed-before-expiry' })
    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    expect(renderTrialExpiredEmail).not.toHaveBeenCalled()
    // Missing integration/property-count rows fall back to safe defaults.
    expect(renderTrialExpiringEmail).toHaveBeenCalledWith(
      expect.objectContaining({ propertyCount: 0, ownerRezConnected: false }),
    )
  })

  it('sends both emails but skips the churn email if they subscribe late', async () => {
    const supabase = makeSupabase({
      organizations: [trialingOrg, trialingOrg, activeOrg],
      integration_connections: [{ data: null, error: null }],
      properties: [{ data: null, error: null, count: 2 } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTrialLifecycle, {
      event: trialEvent(),
      step:  makeStep(),
    })

    expect(result).toEqual({ cancelled: true, reason: 'subscribed-late' })
    expect(resend.emails.send).toHaveBeenCalledTimes(2)
  })
})

describe('handleTrialLifecycle idempotency keys', () => {
  it('keys every email idempotently per-org so a replayed step never double-sends', async () => {
    const supabase = makeSupabase({
      organizations: [trialingOrg, trialingOrg, trialingOrg],
      integration_connections: [{ data: null, error: null }],
      properties: [{ data: null, error: null, count: 0 } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleTrialLifecycle, {
      event: trialEvent({ org_id: 'org_42' }),
      step:  makeStep(),
    })

    const keys = (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]?.idempotencyKey)
    expect(new Set(keys).size).toBe(3)
    expect(keys).toEqual([
      'trial-expiring-org_42',
      'trial-expired-org_42',
      'trial-churn-feedback-org_42',
    ])
  })
})
