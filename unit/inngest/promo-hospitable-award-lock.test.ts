import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { subscriptions: { retrieve: vi.fn() } },
  PLANS:  { growth: { name: 'Growth' }, starter: { name: 'Starter' } },
}))
vi.mock('@/lib/resend/client', () => ({
  sendHospitablePriceLockEmail: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { NonRetriableError } from 'inngest'
import { awardHospitablePriceLock } from '@/lib/inngest/functions/promo-hospitable-award-lock'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { sendHospitablePriceLockEmail } from '@/lib/resend/client'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock plus a `.rpc()` stub — same convention as
// build-shopping-cart.test.ts / cron-guest-pii-retention.test.ts.
// `hospitable_launch_promo` is queried up to twice per run (the tag-check,
// then the congrats-email-already-sent guard), so queued[table] is an
// ordered array consumed in call order, not a fixed per-table response.
function makeSupabase(
  queued: Record<string, { data?: unknown; error?: unknown }[]>,
  rpcResult: { data?: unknown; error?: unknown } = { data: null, error: null },
) {
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

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then        = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  const rpc = vi.fn(() => ({ single: () => Promise.resolve(rpcResult) }))

  return { from, rpc, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const orgBillingRow = {
  id: 'org_1', name: 'Lake House Rentals', billing_email: 'billing@lakehouse.test',
  plan: 'growth', stripe_subscription_id: 'sub_1',
}

const BASE_EVENT = { data: { org_id: 'org_1' } }

describe('awardHospitablePriceLock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: { data: [{ price: { unit_amount: 47900 } }] },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('awards a tier-1 (2-year, numbered) lock, logs the audit event, and sends the congrats email', async () => {
    const supabase = makeSupabase(
      {
        hospitable_launch_promo: [
          { data: { hospitable_tagged: true }, error: null }, // check-hospitable-tagged
          { data: { congrats_email_sent_at: null }, error: null }, // send-congrats-email guard
        ],
        organizations: [{ data: orgBillingRow, error: null }],
      },
      { data: { sequence_number: 7, already_awarded: false, not_eligible: false, window_closed: false, lock_years: 2 }, error: null },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(awardHospitablePriceLock, { event: BASE_EVENT, step: makeStep() })

    expect(result).toEqual({ org_id: 'org_1', status: 'awarded', sequenceNumber: 7, lockYears: 2 })

    expect(supabase.rpc).toHaveBeenCalledWith('claim_hospitable_promo_slot', {
      p_org_id: 'org_1', p_tier: 'growth', p_price_cents: 47900,
    })
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org_1', action: 'billing.hospitable_price_lock.awarded',
        metadata: expect.objectContaining({ sequenceNumber: 7, lockYears: 2, tier: 'growth' }),
      }),
    )
    expect(sendHospitablePriceLockEmail).toHaveBeenCalledWith({
      toEmail: 'billing@lakehouse.test', organizationName: 'Lake House Rentals',
      sequenceNumber: 7, lockYears: 2, lockedTierName: 'Growth', lockedPriceCents: 47900,
    })

    const update = supabase.calls.find((c) => c.table === 'hospitable_launch_promo' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ congrats_email_sent_at: expect.any(String) })
  })

  it('awards a tier-2 (1-year, unnumbered) lock and sends the non-numbered congrats email', async () => {
    const supabase = makeSupabase(
      {
        hospitable_launch_promo: [
          { data: { hospitable_tagged: true }, error: null },
          { data: { congrats_email_sent_at: null }, error: null },
        ],
        organizations: [{ data: orgBillingRow, error: null }],
      },
      { data: { sequence_number: null, already_awarded: false, not_eligible: false, window_closed: false, lock_years: 1 }, error: null },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(awardHospitablePriceLock, { event: BASE_EVENT, step: makeStep() })

    expect(result).toEqual({ org_id: 'org_1', status: 'awarded', sequenceNumber: null, lockYears: 1 })
    expect(sendHospitablePriceLockEmail).toHaveBeenCalledWith(
      expect.objectContaining({ sequenceNumber: null, lockYears: 1 }),
    )
  })

  it('short-circuits to not_eligible without calling Stripe or the claim RPC when the org was never tagged', async () => {
    const supabase = makeSupabase({
      hospitable_launch_promo: [{ data: { hospitable_tagged: false }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(awardHospitablePriceLock, { event: BASE_EVENT, step: makeStep() })

    expect(result).toEqual({ org_id: 'org_1', status: 'not_awarded', reason: 'not_eligible' })
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'organizations')).toBe(false)
  })

  it('fails open to not_eligible (never throws) when the tag-check query itself errors — must never block the shared billing event', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = makeSupabase({
      hospitable_launch_promo: [{ data: null, error: { message: 'connection reset' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(awardHospitablePriceLock, { event: BASE_EVENT, step: makeStep() })

    expect(result).toEqual({ org_id: 'org_1', status: 'not_awarded', reason: 'not_eligible' })
    expect(consoleError).toHaveBeenCalled()
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
  })

  it('returns already_awarded without sending a second email on a retried delivery', async () => {
    const supabase = makeSupabase(
      { hospitable_launch_promo: [{ data: { hospitable_tagged: true }, error: null }], organizations: [{ data: orgBillingRow, error: null }] },
      { data: { sequence_number: 7, already_awarded: true, not_eligible: false, window_closed: false, lock_years: 2 }, error: null },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(awardHospitablePriceLock, { event: BASE_EVENT, step: makeStep() })

    expect(result).toEqual({ org_id: 'org_1', status: 'already_awarded' })
    expect(sendHospitablePriceLockEmail).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('returns not_awarded/window_closed when tier-2\'s 90-day award window has passed and tier 1 is full', async () => {
    const supabase = makeSupabase(
      { hospitable_launch_promo: [{ data: { hospitable_tagged: true }, error: null }], organizations: [{ data: orgBillingRow, error: null }] },
      { data: { sequence_number: null, already_awarded: false, not_eligible: false, window_closed: true, lock_years: null }, error: null },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(awardHospitablePriceLock, { event: BASE_EVENT, step: makeStep() })

    expect(result).toEqual({ org_id: 'org_1', status: 'not_awarded', reason: 'window_closed' })
    expect(sendHospitablePriceLockEmail).not.toHaveBeenCalled()
  })

  it('throws a NonRetriableError when the org has no stripe_subscription_id — cannot price-lock', async () => {
    const supabase = makeSupabase({
      hospitable_launch_promo: [{ data: { hospitable_tagged: true }, error: null }],
      organizations: [{ data: { ...orgBillingRow, stripe_subscription_id: null }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(awardHospitablePriceLock, { event: BASE_EVENT, step: makeStep() }),
    ).rejects.toBeInstanceOf(NonRetriableError)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('skips re-sending the congrats email when congrats_email_sent_at is already set (retry after a step crashed post-send)', async () => {
    const supabase = makeSupabase(
      {
        hospitable_launch_promo: [
          { data: { hospitable_tagged: true }, error: null },
          { data: { congrats_email_sent_at: '2026-07-28T00:00:00.000Z' }, error: null },
        ],
        organizations: [{ data: orgBillingRow, error: null }],
      },
      { data: { sequence_number: 7, already_awarded: false, not_eligible: false, window_closed: false, lock_years: 2 }, error: null },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(awardHospitablePriceLock, { event: BASE_EVENT, step: makeStep() })

    expect(result).toEqual({ org_id: 'org_1', status: 'awarded', sequenceNumber: 7, lockYears: 2 })
    expect(sendHospitablePriceLockEmail).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'hospitable_launch_promo' && c.method === 'update')).toBe(false)
  })

  it('throws a NonRetriableError when org_id is missing from the event payload', async () => {
    await expect(
      invokeHandler(awardHospitablePriceLock, { event: { data: { org_id: '' } }, step: makeStep() }),
    ).rejects.toBeInstanceOf(NonRetriableError)
  })
})
