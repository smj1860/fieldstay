import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { getHospitablePromoStatus } from '@/lib/queries/hospitable-promo'

// `.from(table)` mock — mirrors unit/lib/notifications.test.ts, the other
// caller of the RLS-scoped `createClient()` (not `createServiceClient()`).
function makeSupabase(response: { data?: unknown; error?: unknown }) {
  const calls: { method: string; args: unknown[] }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args })
    return chain
  }
  chain.select      = (...a: unknown[]) => record('select', a)
  chain.eq          = (...a: unknown[]) => record('eq', a)
  chain.maybeSingle = () => {
    calls.push({ method: 'maybeSingle', args: [] })
    return Promise.resolve(response)
  }

  const from = vi.fn(() => chain)
  return { from, calls }
}

describe('getHospitablePromoStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when the org has no promo row (never tagged for Hospitable)', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getHospitablePromoStatus('org_1')

    expect(result).toBeNull()
    expect(supabase.from).toHaveBeenCalledWith('hospitable_launch_promo')
    expect(supabase.calls).toContainEqual({ method: 'eq', args: ['org_id', 'org_1'] })
  })

  it('maps a tier-1 (2-year, numbered) row to HospitablePromoStatus', async () => {
    const supabase = makeSupabase({
      data: {
        price_lock_active: true, price_lock_sequence: 42, price_lock_years: 2,
        price_lock_tier: 'growth', price_lock_expires_at: '2028-07-28T00:00:00.000Z',
      },
      error: null,
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getHospitablePromoStatus('org_1')

    expect(result).toEqual({
      priceLockActive: true, priceLockSequence: 42, priceLockYears: 2,
      priceLockTier: 'growth', priceLockExpiresAt: '2028-07-28T00:00:00.000Z',
    })
  })

  it('maps a tier-2 (1-year, unnumbered) row — priceLockSequence is null by design', async () => {
    const supabase = makeSupabase({
      data: {
        price_lock_active: true, price_lock_sequence: null, price_lock_years: 1,
        price_lock_tier: 'starter', price_lock_expires_at: '2027-07-28T00:00:00.000Z',
      },
      error: null,
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getHospitablePromoStatus('org_1')

    expect(result).toEqual({
      priceLockActive: true, priceLockSequence: null, priceLockYears: 1,
      priceLockTier: 'starter', priceLockExpiresAt: '2027-07-28T00:00:00.000Z',
    })
  })

  // Degrading to "no promo" is right for a marketing banner, but the failure
  // must reach Sentry — a console-only log is invisible in production, which
  // makes a broken read indistinguishable from an org with no promo row.
  it('returns null, logs, AND reports to Sentry when the query itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = makeSupabase({ data: null, error: { message: 'connection reset', code: '42501' } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getHospitablePromoStatus('org_1')

    expect(result).toBeNull()
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('lib.queries.getHospitablePromoStatus'),
      '42501',
      'connection reset',
      expect.anything(),
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection reset' }),
      expect.objectContaining({
        site:  'lib.queries.getHospitablePromoStatus',
        orgId: 'org_1',
      }),
    )
  })
})
