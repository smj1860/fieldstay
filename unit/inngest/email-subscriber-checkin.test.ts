import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))

import { sendSubscriberCheckin } from '@/lib/inngest/functions/email-subscriber-checkin'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order — mirrors checklist-broadcast.test.ts.
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

    chain.single = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from }
}

function makeStep() {
  return {
    run:   vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep: vi.fn(async () => undefined),
  }
}

function checkinEvent(overrides: Partial<{ user_email: string; first_name: string; org_id: string }> = {}) {
  return {
    data: {
      user_email: 'pm@example.com',
      first_name: 'Jamie',
      org_id:     'org_1',
      ...overrides,
    },
  }
}

describe('sendSubscriberCheckin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends the check-in email with correct pluralization for multiple properties', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { plan_status: 'active' }, error: null }],
      properties:    [{ data: null, error: null, count: 3 } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    await invokeHandler(sendSubscriberCheckin, {
      event: checkinEvent(),
      step,
    })

    expect(step.sleep).toHaveBeenCalledWith('sleep-21-days', '21 days')
    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'pm@example.com',
        subject: 'checking in',
        text:    expect.stringContaining('managing 3 properties') as unknown as string,
      }),
      { idempotencyKey: 'subscriber-checkin-org_1' },
    )
  })

  it('uses singular phrasing for exactly one property', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { plan_status: 'active' }, error: null }],
      properties:    [{ data: null, error: null, count: 1 } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(sendSubscriberCheckin, {
      event: checkinEvent(),
      step:  makeStep(),
    })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('managing 1 property') as unknown as string }),
      expect.anything(),
    )
  })

  it('falls back to generic phrasing when the org has zero active properties', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { plan_status: 'active' }, error: null }],
      properties:    [{ data: null, error: null, count: 0 } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(sendSubscriberCheckin, {
      event: checkinEvent(),
      step:  makeStep(),
    })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('I know running your operation keeps you constantly busy') as unknown as string,
      }),
      expect.anything(),
    )
  })

  it('skips the email entirely when the org is no longer an active subscriber', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { plan_status: 'cancelled' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(sendSubscriberCheckin, {
      event: checkinEvent(),
      step:  makeStep(),
    })

    expect(result).toEqual({ skipped: true, reason: 'no-longer-active' })
    expect(resend.emails.send).not.toHaveBeenCalled()
  })
})
