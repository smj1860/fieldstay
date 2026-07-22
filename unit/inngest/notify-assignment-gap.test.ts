import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn().mockResolvedValue({ data: { id: 'email_1' }, error: null }) } },
  FROM:   'FieldStay <notify@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn().mockResolvedValue('<html>alert</html>'),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmMembers: vi.fn(),
}))
vi.mock('@/lib/push/client', () => ({
  sendPushToCrewMember: vi.fn().mockResolvedValue(undefined),
}))

import { notifyAssignmentGap } from '@/lib/inngest/functions/notify-assignment-gap'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { getPmMembers } from '@/lib/inngest/helpers'
import { sendPushToCrewMember } from '@/lib/push/client'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — see checklist-broadcast.test.ts for the
// reference pattern. Each `.from(table)` call consumes the next queued
// response for that table, in call order, resolving whether the chain ends
// in `.single()` or is awaited directly.
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

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const BASE_EVENT = {
  data: {
    turnover_id:   'to_1',
    property_id:   'prop_1',
    org_id:        'org_1',
    turnover_date: '2026-07-25',
    crew_needed:   1,
    crew_found:    0,
  },
}

describe('notifyAssignmentGap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.app'
  })

  it('emails every PM/admin/manager and best-effort pushes those with subscriptions', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { name: 'Lake House' }, error: null }],
      push_subscriptions: [
        { data: [{ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' }], error: null }, // pm_1
        { data: [], error: null }, // pm_2 — no subscriptions
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: 'pm_1', email: 'pm1@test.com', role: 'admin' },
      { userId: 'pm_2', email: 'pm2@test.com', role: 'manager' },
    ])

    const result = await invokeHandler(notifyAssignmentGap, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ sent: 2, recipients: ['pm1@test.com', 'pm2@test.com'] })
    expect(getPmMembers).toHaveBeenCalledWith(supabase, 'org_1', { roles: ['owner', 'admin', 'manager'], limit: 10 })

    expect(resend.emails.send).toHaveBeenCalledTimes(2)
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pm1@test.com', subject: expect.stringContaining('Lake House') }),
      { idempotencyKey: 'assignment-gap-to_1-pm_1' },
    )
    expect(renderPmAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        heading: 'Crew coverage gap',
        ctaUrl:  'https://app.fieldstay.app/turnovers/to_1',
      }),
    )

    // Only pm_1 had a subscription — push sent once.
    expect(sendPushToCrewMember).toHaveBeenCalledTimes(1)
    expect(sendPushToCrewMember).toHaveBeenCalledWith(
      [{ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' }],
      expect.objectContaining({ url: '/turnovers/to_1' }),
    )
  })

  it('is a no-op (no email, no push) when the org has no PM/admin/manager members', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { name: 'Lake House' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await invokeHandler(notifyAssignmentGap, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ sent: 0, reason: 'no_managers' })
    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(sendPushToCrewMember).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'push_subscriptions')).toBe(false)
  })

  it('a failed push send is swallowed and does not affect the email-sent count', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { name: 'Lake House' }, error: null }],
      push_subscriptions: [
        { data: [{ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: 'pm_1', email: 'pm1@test.com', role: 'owner' },
    ])
    ;(sendPushToCrewMember as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('push service down'))

    const result = await invokeHandler(notifyAssignmentGap, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ sent: 1, recipients: ['pm1@test.com'] })
    expect(sendPushToCrewMember).toHaveBeenCalledTimes(1)
  })
})
