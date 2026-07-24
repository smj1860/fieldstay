import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/emails/welcome-v2', () => ({
  renderWelcomeEmailV2: vi.fn(async () => '<html>welcome</html>'),
}))
vi.mock('@/emails/guidebook-feature-announcement', () => ({
  renderGuidebookFeatureAnnouncementEmail: vi.fn(async () => '<html>guidebook</html>'),
}))
vi.mock('@/emails/reengagement-drip', () => ({
  renderReengagementEmail: vi.fn(async () => '<html>reengagement</html>'),
}))

import { onboardingDrip } from '@/lib/inngest/functions/onboarding-drip'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderWelcomeEmailV2 } from '@/emails/welcome-v2'
import { renderGuidebookFeatureAnnouncementEmail } from '@/emails/guidebook-feature-announcement'
import { renderReengagementEmail } from '@/emails/reengagement-drip'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order — mirrors checklist-broadcast.test.ts.
// `profiles` is queried once per suppression check (up to twice); `integration_connections`
// once for the PMS-connected check.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.eq     = () => chain
    chain.limit  = () => chain

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then        = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
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

const defaultLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function dripEvent(overrides: Partial<{
  user_id: string; org_id: string; first_name: string; email: string; org_name: string
}> = {}) {
  return {
    data: {
      user_id:    'user_1',
      org_id:     'org_1',
      first_name: 'Jamie',
      email:      'pm@example.com',
      org_name:   'Lakeview Rentals',
      ...overrides,
    },
  }
}

const notUnsubscribed = { data: { email_unsubscribed_at: null }, error: null }
const noPmsConnection  = { data: [], error: null }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
})

describe('onboardingDrip', () => {
  it('sends all three emails and reports the not-connected variant when no PMS is linked', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed],
      integration_connections: [noPmsConnection],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'email_1' }, error: null })

    const step = makeStep()
    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step,
      logger: defaultLogger,
    })

    expect(result).toEqual({ org_id: 'org_1', emails_sent: 3, variant: 'not_connected' })
    expect(resend.emails.send).toHaveBeenCalledTimes(3)
    expect(step.sleep).toHaveBeenNthCalledWith(1, 'wait-72h', '72h')
    expect(step.sleep).toHaveBeenNthCalledWith(2, 'wait-96h', '96h')

    expect(renderWelcomeEmailV2).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Jamie', orgName: 'Lakeview Rentals' }))
    expect(renderGuidebookFeatureAnnouncementEmail).toHaveBeenCalledWith(
      expect.objectContaining({ pmFirstName: 'Jamie' }),
    )
    expect(renderReengagementEmail).toHaveBeenCalledWith(expect.objectContaining({ isConnected: false }))

    const subjects = (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { subject: string }).subject,
    )
    expect(subjects).toEqual([
      "You made the right call. Here's where to start.",
      'The Guidebook That Knows What Time It Is',
      "7 days in. Here's what you're missing.",
    ])

    const keys = (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]?.idempotencyKey)
    expect(keys).toEqual([
      'onboarding-welcome-org_1',
      'onboarding-guidebook-org_1',
      'onboarding-reengagement-org_1',
    ])
  })

  it('reports the connected variant with different subject/copy when a PMS is linked by day 7', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed],
      integration_connections: [{ data: [{ provider_id: 'ownerrez' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'email_1' }, error: null })

    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ org_id: 'org_1', emails_sent: 3, variant: 'connected' })
    expect(renderReengagementEmail).toHaveBeenCalledWith(expect.objectContaining({ isConnected: true }))

    const lastSubject = (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { subject: string }
    expect(lastSubject.subject).toBe('Your guests left reviews this week. Did you respond?')
  })

  it('stops before the guidebook email when the user unsubscribed during the first 72h', async () => {
    const supabase = makeSupabase({
      profiles: [{ data: { email_unsubscribed_at: '2026-07-20T00:00:00.000Z' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'email_1' }, error: null })

    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ stopped: true, reason: 'unsubscribed', emails_sent: 1 })
    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    expect(renderGuidebookFeatureAnnouncementEmail).not.toHaveBeenCalled()
    expect(renderReengagementEmail).not.toHaveBeenCalled()
  })

  it('stops before the reengagement email when the user unsubscribed between 72h and 168h', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, { data: { email_unsubscribed_at: '2026-07-21T00:00:00.000Z' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'email_1' }, error: null })

    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ stopped: true, reason: 'unsubscribed', emails_sent: 2 })
    expect(resend.emails.send).toHaveBeenCalledTimes(2)
    expect(renderReengagementEmail).not.toHaveBeenCalled()
  })

  it('logs but does not throw or halt the sequence when the welcome send itself returns a Resend error', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed],
      integration_connections: [noPmsConnection],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: null, error: { message: 'invalid recipient' } })
      .mockResolvedValue({ data: { id: 'email_ok' }, error: null })

    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(defaultLogger.error).toHaveBeenCalledWith(expect.stringContaining('Welcome email failed'))
    // The sequence still proceeds — a failed send doesn't halt the drip.
    expect(result).toEqual({ org_id: 'org_1', emails_sent: 3, variant: 'not_connected' })
    expect(resend.emails.send).toHaveBeenCalledTimes(3)
  })

  it('logs but does not throw when the welcome send itself throws', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed],
      integration_connections: [noPmsConnection],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ data: { id: 'email_ok' }, error: null })

    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(defaultLogger.error).toHaveBeenCalledWith(expect.stringContaining('Welcome email threw'))
    expect(result).toEqual({ org_id: 'org_1', emails_sent: 3, variant: 'not_connected' })
  })
})
