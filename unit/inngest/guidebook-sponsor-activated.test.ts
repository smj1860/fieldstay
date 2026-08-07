import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/guidebook/helpers', () => ({
  getActiveSponsorCount: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { guidebookSponsorActivated } from '@/lib/inngest/functions/guidebook-sponsor-activated'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and guidebook-daily-monitor. `guidebook_configurations` is hit twice in
// the unlock branch (existing-config select via maybeSingle, then the
// upsert), so a fixed per-table response isn't enough — order matters.
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
    chain.update = (...a: unknown[]) => record('update', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function checkoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      checkoutSessionId: 'cs_1',
      sponsorId:         'sponsor_1',
      orgId:             'org_1',
      subscriptionId:    'sub_1',
      customerId:        'cus_1',
      ...overrides,
    },
  }
}

describe('guidebookSponsorActivated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('activates the sponsor row and unlocks the guidebook once the 3-sponsor threshold is reached', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        { data: { trial_ends_at: null }, error: null }, // not in trial
        { data: null, error: null },                    // upsert
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(3)

    const result = await invokeHandler(guidebookSponsorActivated, { event: checkoutEvent(), step: makeStep() })

    const sponsorUpdate = supabase.calls.find((c) => c.table === 'guidebook_sponsors' && c.method === 'update')
    expect(sponsorUpdate?.args[0]).toMatchObject({
      status:                 'active',
      stripe_subscription_id: 'sub_1',
      stripe_customer_id:     'cus_1',
    })
    // Stated as "every guidebook_sponsors access is scoped by BOTH id and
    // org_id" rather than as a positional list, so adding a read to this step
    // cannot quietly weaken it into passing on a subset.
    const sponsorEqArgs = supabase.calls
      .filter((c) => c.table === 'guidebook_sponsors' && c.method === 'eq')
      .map((c) => JSON.stringify(c.args))

    const idScoped     = sponsorEqArgs.filter((a) => a === JSON.stringify(['id', 'sponsor_1'])).length
    const orgScoped    = sponsorEqArgs.filter((a) => a === JSON.stringify(['org_id', 'org_1'])).length
    const distinctArgs = new Set(sponsorEqArgs)

    // Every id filter is matched by an org filter, so no statement can reach a
    // sponsor row on id alone.
    expect(orgScoped).toBe(idScoped)
    expect(idScoped).toBeGreaterThan(0)
    expect(distinctArgs).toEqual(
      new Set([JSON.stringify(['id', 'sponsor_1']), JSON.stringify(['org_id', 'org_1'])]),
    )

    const configUpsert = supabase.calls.find((c) => c.table === 'guidebook_configurations' && c.method === 'upsert')
    expect(configUpsert?.args[0]).toMatchObject({ org_id: 'org_1', is_active: true, grace_period_ends_at: null })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:   'guidebook.sponsor.activated',
        targetId: 'sponsor_1',
        metadata: { activeSponsorCount: 3, guidebookUnlocked: true },
      }),
    )
    expect(result).toEqual({ activeSponsorCount: 3, sponsorId: 'sponsor_1', orgId: 'org_1', wasUnlocked: true })
  })

  it('unlocks the guidebook while still in the 30-day free trial even with only 1 active sponsor', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        // Relative, not hardcoded. This was '2026-08-01T00:00:00.000Z' with the
        // comment "trial ends in the future" — true when written, false from
        // 2026-08-01T00:00:00Z onward, at which point the test began failing
        // permanently. A fixture asserting "in the future" must be computed
        // from now, or it dates itself.
        { data: { trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }, error: null },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)

    const result = await invokeHandler(guidebookSponsorActivated, { event: checkoutEvent(), step: makeStep() })

    expect(supabase.calls.some((c) => c.table === 'guidebook_configurations' && c.method === 'upsert')).toBe(true)
    expect(result).toMatchObject({ wasUnlocked: true })
  })

  it('does not unlock the guidebook when outside the trial and still below the 3-sponsor threshold', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        { data: { trial_ends_at: '2026-01-01T00:00:00.000Z' }, error: null }, // trial already ended
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(2)

    const result = await invokeHandler(guidebookSponsorActivated, { event: checkoutEvent(), step: makeStep() })

    expect(supabase.calls.some((c) => c.table === 'guidebook_configurations' && c.method === 'upsert')).toBe(false)
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { activeSponsorCount: 2, guidebookUnlocked: false } }),
    )
    expect(result).toEqual({ activeSponsorCount: 2, sponsorId: 'sponsor_1', orgId: 'org_1', wasUnlocked: false })
  })

  it('idempotency: replaying the same checkout-completed event twice activates without erroring or diverging results', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }, { data: null, error: null }],
      guidebook_configurations: [
        { data: { trial_ends_at: null }, error: null },
        { data: null, error: null },
        { data: { trial_ends_at: null }, error: null },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(4)

    const first  = await invokeHandler(guidebookSponsorActivated, { event: checkoutEvent(), step: makeStep() })
    const second = await invokeHandler(guidebookSponsorActivated, { event: checkoutEvent(), step: makeStep() })

    // Plain UPDATE/UPSERT — replaying is naturally idempotent: same result
    // both times, and each run performs exactly one activation write.
    expect(first).toEqual(second)
    expect(supabase.calls.filter((c) => c.table === 'guidebook_sponsors' && c.method === 'update')).toHaveLength(2)
    expect(logAuditEvent).toHaveBeenCalledTimes(2)
  })

  it('throws when the unlock upsert fails, instead of reporting an unlock that never happened', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        { data: { trial_ends_at: null }, error: null },
        { data: null, error: { message: 'permission denied for table guidebook_configurations' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(3)

    // Discarded, a failed unlock left the guidebook locked while the step
    // returned wasUnlocked: true and the audit row recorded an unlock that
    // never happened — the sponsor paid and the guidebook stayed dark, with
    // the record saying otherwise. Matches the identical upsert in
    // guidebook-sponsor-payment-recovered, which always threw.
    await expect(
      invokeHandler(guidebookSponsorActivated, { event: checkoutEvent(), step: makeStep() })
    ).rejects.toThrow(/Failed to unlock guidebook/)

    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('reports — rather than silently overwriting — when a second subscription id replaces a live one', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [
        { data: { stripe_subscription_id: 'sub_previous' }, error: null }, // already has a live subscription
        { data: null, error: null },                                       // the activation update
      ],
      guidebook_configurations: [{ data: { trial_ends_at: null }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)

    await invokeHandler(guidebookSponsorActivated, { event: checkoutEvent(), step: makeStep() })

    // Overwriting stripe_subscription_id orphans the previous subscription:
    // it keeps billing the business monthly and nothing in FieldStay can
    // reach it any more. The write still proceeds (the new subscription is
    // the real one now) but the anomaly must not pass unnoticed.
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Sponsor activated with a second Stripe subscription' }),
      expect.objectContaining({
        site:  'inngest.guidebook-sponsor-activated.duplicate-subscription',
        extra: expect.objectContaining({
          prior_subscription_id: 'sub_previous',
          new_subscription_id:   'sub_1',
        }),
      }),
    )
  })

  it('does not report when a replay writes back the SAME subscription id', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [
        { data: { stripe_subscription_id: 'sub_1' }, error: null }, // same as the event's
        { data: null, error: null },
      ],
      guidebook_configurations: [{ data: { trial_ends_at: null }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)

    await invokeHandler(guidebookSponsorActivated, { event: checkoutEvent(), step: makeStep() })

    expect(reportError).not.toHaveBeenCalled()
  })
})
