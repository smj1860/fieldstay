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
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { onboardingDrip } from '@/lib/inngest/functions/onboarding-drip'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderWelcomeEmailV2 } from '@/emails/welcome-v2'
import { renderGuidebookFeatureAnnouncementEmail } from '@/emails/guidebook-feature-announcement'
import { renderReengagementEmail } from '@/emails/reengagement-drip'
import { reportError } from '@/lib/observability/report-error'
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
    chain.gte    = () => chain

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

// resolveEmailAudience() reads BOTH columns and fails closed, so the token
// must be present or every send is (correctly) suppressed.
const notUnsubscribed = {
  data:  { email_unsubscribed_at: null, unsubscribe_token: 'f'.repeat(64) },
  error: null,
}
const unsubscribedAt = (at: string) => ({
  data:  { email_unsubscribed_at: at, unsubscribe_token: 'f'.repeat(64) },
  error: null,
})
const noPmsConnection  = { data: [], error: null }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
})

describe('onboardingDrip', () => {
  it('sends all three emails and reports the not-connected variant when no PMS is linked', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed, notUnsubscribed],
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

  // reviewCount used to be the literal `3` at the call site, so every
  // connected PM was told "3 came in this week — RepuGuard already has draft
  // responses ready for your approval" no matter what was in their account:
  // a false factual claim in a commercial email, disproved by clicking the CTA.
  it('reports the connected variant with the REAL review count when a PMS is linked by day 7', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed, notUnsubscribed],
      integration_connections: [{ data: [{ provider_id: 'ownerrez' }], error: null }],
      reviews: [{ data: null, error: null, count: 4 } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'email_1' }, error: null })

    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ org_id: 'org_1', emails_sent: 3, variant: 'connected' })
    expect(renderReengagementEmail).toHaveBeenCalledWith(
      expect.objectContaining({ isConnected: true, reviewCount: 4 }),
    )

    const lastSubject = (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { subject: string }
    expect(lastSubject.subject).toBe('Your guests left reviews this week. Did you respond?')
  })

  // The zero case is reachable now that the count is real, and the
  // reviews-arrived subject ("Did you respond?") presumes an event that did
  // not happen — so connected-with-no-reviews needs its own subject, not a
  // fall-through to the "your PMS isn't connected yet" one, which is equally
  // untrue for this recipient.
  it('sends the connected-but-no-reviews variant when the org genuinely had none this week', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed, notUnsubscribed],
      integration_connections: [{ data: [{ provider_id: 'ownerrez' }], error: null }],
      reviews: [{ data: null, error: null, count: 0 } as unknown as { data: unknown; error: unknown }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'email_1' }, error: null })

    await invokeHandler(onboardingDrip, { event: dripEvent(), step: makeStep(), logger: defaultLogger })

    expect(renderReengagementEmail).toHaveBeenCalledWith(
      expect.objectContaining({ isConnected: true, reviewCount: 0 }),
    )
    const lastSubject = (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { subject: string }
    expect(lastSubject.subject).toBe('One week in. FieldStay is watching your reviews.')
  })

  // No PMS connected => no review query at all, and reviewCount stays 0.
  it('does not query reviews when no PMS is connected', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed, notUnsubscribed],
      integration_connections: [noPmsConnection],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'email_1' }, error: null })

    await invokeHandler(onboardingDrip, { event: dripEvent(), step: makeStep(), logger: defaultLogger })

    expect(supabase.from).not.toHaveBeenCalledWith('reviews')
    expect(renderReengagementEmail).toHaveBeenCalledWith(
      expect.objectContaining({ isConnected: false, reviewCount: 0 }),
    )
  })

  // These three cover the actual CAN-SPAM defect this sequence shipped with:
  // email_unsubscribed_at was read here but written by nothing, and no template
  // carried an opt-out link, so the suppression below was unreachable.
  it('sends nothing at all when the recipient already opted out before the drip starts', async () => {
    const supabase = makeSupabase({
      profiles: [unsubscribedAt('2026-07-01T00:00:00.000Z')],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ stopped: true, reason: 'unsubscribed', emails_sent: 0 })
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('fails CLOSED — sends nothing when the profile read errors', async () => {
    // An outage must not silently turn into "nobody is unsubscribed". A
    // suppressed marketing email costs nothing; an unsuppressed one is mail to
    // someone who asked us to stop.
    const supabase = makeSupabase({
      profiles: [{ data: null, error: { message: 'db down' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ stopped: true, reason: 'unsubscribed', emails_sent: 0 })
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('puts a real unsubscribe link and List-Unsubscribe headers on every send', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed, notUnsubscribed],
      integration_connections: [noPmsConnection],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'email_1' }, error: null })

    await invokeHandler(onboardingDrip, {
      event:  dripEvent(),
      step:   makeStep(),
      logger: defaultLogger,
    })

    const expectedUrl = `https://app.fieldstay.test/unsubscribe/${'f'.repeat(64)}`

    // RFC 8058 one-click headers on all three sends.
    const sends = (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls
    expect(sends).toHaveLength(3)
    for (const [payload] of sends) {
      const headers = (payload as { headers?: Record<string, string> }).headers ?? {}
      expect(headers['List-Unsubscribe']).toContain('/api/email/unsubscribe?token=')
      expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    }

    // ...and a visible footer link in the rendered templates.
    expect(renderWelcomeEmailV2).toHaveBeenCalledWith(
      expect.objectContaining({ unsubscribeUrl: expectedUrl }),
    )
    expect(renderGuidebookFeatureAnnouncementEmail).toHaveBeenCalledWith(
      expect.objectContaining({ unsubscribeUrl: expectedUrl }),
    )
    expect(renderReengagementEmail).toHaveBeenCalledWith(
      expect.objectContaining({ unsubscribeUrl: expectedUrl }),
    )
  })

  it('stops before the guidebook email when the user unsubscribed during the first 72h', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, unsubscribedAt('2026-07-20T00:00:00.000Z')],
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
      profiles: [notUnsubscribed, notUnsubscribed, unsubscribedAt('2026-07-21T00:00:00.000Z')],
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
      profiles: [notUnsubscribed, notUnsubscribed, notUnsubscribed],
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
    // The Resend SDK returns { data, error } for API-level failures and only
    // throws for transport ones, so THIS is the common failure shape — and it
    // was the one branch that never reached Sentry.
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'invalid recipient' }),
      expect.objectContaining({ site: 'inngest.onboarding-drip.welcome', orgId: 'org_1' }),
    )
    // The sequence still proceeds — a failed send doesn't halt the drip — but
    // the count is now what was actually sent, not a hardcoded 3.
    expect(result).toEqual({ org_id: 'org_1', emails_sent: 2, variant: 'not_connected' })
    expect(resend.emails.send).toHaveBeenCalledTimes(3)
  })

  // A Resend validation error echoes the offending `to` address back in its
  // message, and CLAUDE.md bans email addresses from logs — the old call site
  // was JSON.stringify(error), which would have written it straight to Axiom.
  it('never writes the Resend error body (which can echo the recipient address) to the log', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed, notUnsubscribed],
      integration_connections: [noPmsConnection],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: null,
        error: { name: 'validation_error', message: 'Invalid `to` field: pm@example.com is not a valid address' },
      })
      .mockResolvedValue({ data: { id: 'email_ok' }, error: null })

    await invokeHandler(onboardingDrip, { event: dripEvent(), step: makeStep(), logger: defaultLogger })

    for (const [msg] of defaultLogger.error.mock.calls) {
      expect(String(msg)).not.toContain('pm@example.com')
    }
    expect(defaultLogger.error).toHaveBeenCalledWith('[Drip:org_1] Welcome email failed: validation_error')
  })

  it('logs but does not throw when the welcome send itself throws', async () => {
    const supabase = makeSupabase({
      profiles: [notUnsubscribed, notUnsubscribed, notUnsubscribed],
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

    expect(defaultLogger.error).toHaveBeenCalledWith(expect.stringContaining('Welcome email failed'))
    expect(reportError).toHaveBeenCalled()
    expect(result).toEqual({ org_id: 'org_1', emails_sent: 2, variant: 'not_connected' })
  })
})
