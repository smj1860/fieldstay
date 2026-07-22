import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/guidebook/helpers', () => ({
  getActiveSponsorCount: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  sendGuidebookGracePeriodEmail: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { guidebookSponsorDeactivated } from '@/lib/inngest/functions/guidebook-sponsor-deactivated'
import { createServiceClient } from '@/lib/supabase/server'
import { getActiveSponsorCount } from '@/lib/guidebook/helpers'
import { getPmEmails } from '@/lib/inngest/helpers'
import { sendGuidebookGracePeriodEmail } from '@/lib/resend/client'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and guidebook-daily-monitor. `guidebook_configurations` can be hit twice
// (existing-config select via maybeSingle, then the grace-period update),
// so a fixed per-table response isn't enough — order matters.
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
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
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

function cancelledEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'guidebook/sponsor.subscription.cancelled',
    data: { subscriptionId: 'sub_1', orgId: 'org_1', sponsorId: 'sponsor_1', ...overrides },
  }
}

function paymentFailedEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'guidebook/sponsor.payment.failed',
    data: { subscriptionId: 'sub_1', orgId: 'org_1', sponsorId: 'sponsor_1', ...overrides },
  }
}

describe('guidebookSponsorDeactivated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
  })

  it('opens a 5-day grace period and emails every PM when a cancellation drops the org below 3 sponsors', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        { data: { is_active: true, grace_period_ends_at: null }, error: null }, // existing config
        { data: null, error: null },                                           // grace-period update
      ],
      organizations: [{ data: { name: 'Lakefront Rentals' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(2)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    const result = await invokeHandler(guidebookSponsorDeactivated, { event: cancelledEvent(), step: makeStep() })

    const sponsorUpdate = supabase.calls.find((c) => c.table === 'guidebook_sponsors' && c.method === 'update')
    expect(sponsorUpdate?.args[0]).toMatchObject({ status: 'cancelled' })
    expect(sponsorUpdate?.args[0]).toHaveProperty('deactivated_at')

    const configUpdate = supabase.calls.find((c) => c.table === 'guidebook_configurations' && c.method === 'update')
    expect(configUpdate?.args[0]).toHaveProperty('grace_period_ends_at')

    expect(sendGuidebookGracePeriodEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail:        'pm@example.com',
        orgName:        'Lakefront Rentals',
        activeSponsors: 2,
        guidebookUrl:   'https://app.fieldstay.test/guidebook',
      }),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:   'guidebook.sponsor.cancelled',
        targetId: 'sponsor_1',
        metadata: expect.objectContaining({ activeSponsorCount: 2, gracePeriodEndsAt: expect.any(String) }),
      }),
    )
    expect(result).toEqual({ activeSponsorCount: 2, sponsorId: 'sponsor_1', orgId: 'org_1' })
  })

  it('marks the sponsor row payment_failed (not cancelled) for a payment-failure event and logs the matching audit action', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        { data: { is_active: true, grace_period_ends_at: null }, error: null },
        { data: null, error: null },
      ],
      organizations: [{ data: { name: 'Lakefront Rentals' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    await invokeHandler(guidebookSponsorDeactivated, { event: paymentFailedEvent(), step: makeStep() })

    const sponsorUpdate = supabase.calls.find((c) => c.table === 'guidebook_sponsors' && c.method === 'update')
    expect(sponsorUpdate?.args[0]).toMatchObject({ status: 'payment_failed' })
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'guidebook.sponsor.payment_failed' }),
    )
  })

  it('is a no-op on the guidebook lock when active sponsors stay at or above 3 — no config query, no PM email', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(3)

    const result = await invokeHandler(guidebookSponsorDeactivated, { event: cancelledEvent(), step: makeStep() })

    expect(supabase.calls.some((c) => c.table === 'guidebook_configurations')).toBe(false)
    expect(getPmEmails).not.toHaveBeenCalled()
    expect(sendGuidebookGracePeriodEmail).not.toHaveBeenCalled()
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { activeSponsorCount: 3, gracePeriodEndsAt: null } }),
    )
    expect(result).toEqual({ activeSponsorCount: 3, sponsorId: 'sponsor_1', orgId: 'org_1' })
  })

  it('idempotency: does not reset the countdown or re-notify the PM when a grace period is already running', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        { data: { is_active: true, grace_period_ends_at: '2026-07-25T00:00:00.000Z' }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)

    await invokeHandler(guidebookSponsorDeactivated, { event: cancelledEvent(), step: makeStep() })

    expect(supabase.calls.some((c) => c.table === 'guidebook_configurations' && c.method === 'update')).toBe(false)
    expect(getPmEmails).not.toHaveBeenCalled()
    expect(sendGuidebookGracePeriodEmail).not.toHaveBeenCalled()
  })

  it('idempotency: does not open a grace period or notify when the guidebook is already locked (is_active false)', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        { data: { is_active: false, grace_period_ends_at: null }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(0)

    await invokeHandler(guidebookSponsorDeactivated, { event: cancelledEvent(), step: makeStep() })

    expect(supabase.calls.some((c) => c.table === 'guidebook_configurations' && c.method === 'update')).toBe(false)
    expect(sendGuidebookGracePeriodEmail).not.toHaveBeenCalled()
  })

  it('opens the grace period but sends no email when the org has no PM addresses on file', async () => {
    const supabase = makeSupabase({
      guidebook_sponsors: [{ data: null, error: null }],
      guidebook_configurations: [
        { data: { is_active: true, grace_period_ends_at: null }, error: null },
        { data: null, error: null },
      ],
      organizations: [{ data: { name: 'Lakefront Rentals' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getActiveSponsorCount as ReturnType<typeof vi.fn>).mockResolvedValue(1)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue([])

    await invokeHandler(guidebookSponsorDeactivated, { event: cancelledEvent(), step: makeStep() })

    expect(sendGuidebookGracePeriodEmail).not.toHaveBeenCalled()
  })
})
