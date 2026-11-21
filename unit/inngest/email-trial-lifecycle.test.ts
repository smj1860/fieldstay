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
    // The PMS lookup filters `.in('provider_id', PMS_PROVIDER_IDS)` and orders
    // + limits so the name shown is deterministic when an org has connected
    // two. Chainable no-ops here — the queue decides what comes back.
    chain.in     = () => chain
    chain.order  = () => chain
    chain.limit  = () => chain

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
  org_id: string; user_id: string; user_email: string; first_name: string; org_name: string; trial_ends_at: string
}> = {}) {
  return {
    data: {
      org_id:        'org_1',
      user_id:       'user_1',
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
// The sequence also re-reads trial_ends_at each time it wakes (to notice an
// extension). Per run, `organizations` is read in this order:
//   warning: left? , extended? | expiry: left? , extended? | churn: left?
const unchanged   = { data: { trial_ends_at: null }, error: null }
const movedTo     = (iso: string) => ({ data: { trial_ends_at: iso }, error: null })

// The churn/win-back email is COMMERCIAL (its P.S. links to /billing-wall), so
// it resolves the recipient's CAN-SPAM opt-out state first. resolveEmailAudience
// fails closed, so the profile must be readable AND carry a token or the send is
// correctly suppressed.
const churnOptedIn = {
  data:  { email_unsubscribed_at: null, unsubscribe_token: 'f'.repeat(64) },
  error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
})

describe('handleTrialLifecycle', () => {
  it('runs the full sequence and sends all three emails when the org never subscribes', async () => {
    const supabase = makeSupabase({
      organizations: [trialingOrg, unchanged, trialingOrg, unchanged, trialingOrg],
      integration_connections: [{ data: { provider_id: 'ownerrez' }, error: null }],
      properties: [{ data: null, error: null, count: 4 } as unknown as { data: unknown; error: unknown }],
      profiles: [churnOptedIn],
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
      expect.objectContaining({ firstName: 'Jamie', orgName: 'Lakeview Rentals', propertyCount: 4, connectedPmsName: 'OwnerRez' }),
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
      organizations: [trialingOrg, unchanged, activeOrg],
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
      expect.objectContaining({ propertyCount: 0, connectedPmsName: null }),
    )
  })

  it('sends both emails but skips the churn email if they subscribe late', async () => {
    const supabase = makeSupabase({
      organizations: [trialingOrg, unchanged, trialingOrg, unchanged, activeOrg],
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

  // The plan-status check used to be `const { data: org } = await ...` with the
  // error discarded, so a read failure produced `plan_status === undefined`,
  // which read as "not subscribed" and marched the sequence on. The failure
  // direction is the customer-hostile one: it tells a PAYING customer their
  // trial ended, then asks them why FieldStay wasn't the right fit.
  it('throws (so Inngest retries) rather than assuming "still trialing" when the plan-status read errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = makeSupabase({
      organizations: [{ data: null, error: { message: 'connection reset', code: '08006' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleTrialLifecycle, { event: trialEvent(), step: makeStep() }),
    ).rejects.toThrow()
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  // past_due is a CONVERTED customer whose card declined — core-billing's
  // dunning owns them and they stay inside the app (past-due banner, not the
  // billing wall). The check asks "still trialing?", not "active?", precisely
  // so this org does not get a churn-feedback email alongside its dunning one.
  it.each(['past_due', 'cancelled', 'paused'])(
    'stops the sequence for plan_status=%s — only "trialing" keeps it alive',
    async (planStatus) => {
      const supabase = makeSupabase({ organizations: [{ data: { plan_status: planStatus }, error: null }] })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      const result = await invokeHandler(handleTrialLifecycle, { event: trialEvent(), step: makeStep() })

      expect(result).toEqual({ cancelled: true, reason: 'subscribed-before-warning' })
      expect(resend.emails.send).not.toHaveBeenCalled()
    },
  )

  // A deleted org is a null row, not an error — maybeSingle rather than the
  // .single() this used to call, whose PGRST116 would have been swallowed by
  // the same discarded-error path.
  it('stops the sequence when the org row no longer exists (deleted account)', async () => {
    const supabase = makeSupabase({ organizations: [{ data: null, error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTrialLifecycle, { event: trialEvent(), step: makeStep() })

    expect(result).toEqual({ cancelled: true, reason: 'subscribed-before-warning' })
    expect(resend.emails.send).not.toHaveBeenCalled()
  })
})

describe('handleTrialLifecycle idempotency keys', () => {
  it('keys every email idempotently per-org so a replayed step never double-sends', async () => {
    const supabase = makeSupabase({
      organizations: [trialingOrg, unchanged, trialingOrg, unchanged, trialingOrg],
      integration_connections: [{ data: null, error: null }],
      properties: [{ data: null, error: null, count: 0 } as unknown as { data: unknown; error: unknown }],
      profiles: [churnOptedIn],
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

describe('handleTrialLifecycle: an extended trial', () => {
  const OLD_END = '2026-08-01T00:00:00.000Z'
  const NEW_END = '2026-08-08T00:00:00.000Z'

  function setup(organizations: { data?: unknown; error?: unknown }[]) {
    const supabase = makeSupabase({
      organizations,
      integration_connections: [{ data: null, error: null }, { data: null, error: null }],
      properties: [
        { data: null, error: null, count: 0 } as unknown as { data: unknown; error: unknown },
        { data: null, error: null, count: 0 } as unknown as { data: unknown; error: unknown },
      ],
      profiles: [churnOptedIn],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    return makeStep()
  }

  const sentKeys = () => (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]?.idempotencyKey)

  // The case that prompted this: the 3-day warning already went out, THEN the trial was extended.
  // Without the re-check, "Your FieldStay trial has ended" arrives on the old date.
  it('does not send "trial has ended" on the old date when the trial was extended after the warning', async () => {
    const step = setup([
      trialingOrg, unchanged,                  // round 0 warning: not extended yet
      trialingOrg, movedTo(NEW_END),           // round 0 expiry: extended!
      trialingOrg, unchanged,                  // round 1 warning
      trialingOrg, unchanged,                  // round 1 expiry
      trialingOrg,                             // churn
    ])
    await invokeHandler(handleTrialLifecycle, { event: trialEvent({ trial_ends_at: OLD_END }), step })

    expect(sentKeys()).toEqual([
      'trial-expiring-org_1',        // the original warning, sent before the extension
      'trial-expiring-org_1-r1',     // a fresh warning for the NEW end date
      'trial-expired-org_1-r1',      // the expiry email, on the new date only
      'trial-churn-feedback-org_1',
    ])
    expect(sentKeys()).not.toContain('trial-expired-org_1')
    // The expired email states the NEW end date plus its 30 days, not the old one.
    expect(renderTrialExpiredEmail).toHaveBeenCalledTimes(1)
    const shown = (renderTrialExpiredEmail as ReturnType<typeof vi.fn>).mock.calls[0][0].dataExpiresDate
    expect(shown).toBe(new Date(new Date(NEW_END).getTime() + 30 * 86_400_000)
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))
    // Sleeps: warning + expiry for round 0, then again for round 1.
    expect((step.sleepUntil.mock.calls as unknown as [string, Date][]).map((c) => c[0])).toEqual([
      'sleep-until-warning', 'sleep-until-expired', 'sleep-until-warning-r1', 'sleep-until-expired-r1',
    ])
  })

  it('re-plans before the warning when the trial is extended before it fires', async () => {
    const step = setup([
      trialingOrg, movedTo(NEW_END),           // round 0 warning wake: extended, so no warning yet
      trialingOrg, unchanged,
      trialingOrg, unchanged,
      trialingOrg,
    ])
    await invokeHandler(handleTrialLifecycle, { event: trialEvent({ trial_ends_at: OLD_END }), step })

    expect(sentKeys()).toEqual(['trial-expiring-org_1-r1', 'trial-expired-org_1-r1', 'trial-churn-feedback-org_1'])
    expect(sentKeys()).not.toContain('trial-expiring-org_1')
  })

  it('still stops the whole sequence if they subscribe after being extended', async () => {
    setup([trialingOrg, unchanged, trialingOrg, movedTo(NEW_END), activeOrg])
    const result = await invokeHandler(handleTrialLifecycle, { event: trialEvent({ trial_ends_at: OLD_END }), step: makeStep() })
    expect(result).toEqual({ cancelled: true, reason: 'subscribed-before-warning' })
    expect(sentKeys()).toEqual(['trial-expiring-org_1'])
  })

  it('ignores a trial that was shortened or not moved: nothing re-plans', async () => {
    setup([
      trialingOrg, movedTo('2026-07-30T00:00:00.000Z'),
      trialingOrg, movedTo(OLD_END),
      trialingOrg,
    ])
    await invokeHandler(handleTrialLifecycle, { event: trialEvent({ trial_ends_at: OLD_END }), step: makeStep() })
    expect(sentKeys()).toEqual(['trial-expiring-org_1', 'trial-expired-org_1', 'trial-churn-feedback-org_1'])
  })

  // A bug that kept moving the date must not make one run schedule steps forever.
  it('stops re-planning after the cap and sends the emails for the date it has', async () => {
    const day = 86_400_000
    const orgs: { data?: unknown; error?: unknown }[] = []
    for (let round = 0; round < 5; round++) {
      orgs.push(trialingOrg, movedTo(new Date(new Date(OLD_END).getTime() + (round + 1) * day).toISOString()))
    }
    orgs.push(trialingOrg, movedTo('2030-01-01T00:00:00.000Z'), trialingOrg, movedTo('2030-01-01T00:00:00.000Z'), trialingOrg)
    setup(orgs)
    await invokeHandler(handleTrialLifecycle, { event: trialEvent({ trial_ends_at: OLD_END }), step: makeStep() })
    expect(sentKeys()).toEqual(['trial-expiring-org_1-r5', 'trial-expired-org_1-r5', 'trial-churn-feedback-org_1'])
  })
})

// Sequences already asleep were started under these exact step ids. Inngest matches a
// replaying run to its recorded history by id, so renaming one strands every sequence in flight.
describe('handleTrialLifecycle: step ids of sequences already in flight', () => {
  it('keeps every original step id for the first round', async () => {
    const supabase = makeSupabase({
      organizations: [trialingOrg, unchanged, trialingOrg, unchanged, trialingOrg],
      integration_connections: [{ data: null, error: null }],
      properties: [{ data: null, error: null, count: 0 } as unknown as { data: unknown; error: unknown }],
      profiles: [churnOptedIn],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const step = makeStep()
    await invokeHandler(handleTrialLifecycle, { event: trialEvent(), step })

    const runs = step.run.mock.calls.map((c) => c[0])
    for (const id of [
      'check-subscription-before-warning', 'send-trial-expiring-email', 'check-subscription-at-expiry',
      'send-trial-expired-email', 'check-subscription-before-churn', 'check-churn-suppression', 'send-churn-feedback-email',
    ]) expect(runs).toContain(id)
    expect((step.sleepUntil.mock.calls as unknown as [string, Date][]).map((c) => c[0])).toEqual(['sleep-until-warning', 'sleep-until-expired'])
    expect(step.sleep).toHaveBeenCalledWith('sleep-before-churn-email', '3 days')
  })
})
