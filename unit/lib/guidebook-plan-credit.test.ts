import { describe, it, expect, vi } from 'vitest'

// helpers.ts pulls in createServiceClient (next/headers) at module scope for
// getActiveSponsorCount. resolvePlanCredit itself is pure and touches none of
// it, so stub the client rather than skip testing the real function — the
// handler test mocks resolvePlanCredit away entirely, so THIS file is the only
// place the shipped implementation is exercised.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { resolvePlanCredit, CREDIT_PER_SPONSOR_CENTS } from '@/lib/guidebook/helpers'

// ============================================================================
// Flat $5 per active sponsor, per month, from the first one.
//
// Replaced a two-step threshold (5 → $10, 6 → $25). The property worth pinning
// is that the new shape has no cliffs: every additional sponsor is worth
// exactly the same as the one before it.
// ============================================================================

describe('resolvePlanCredit', () => {
  it('pays a flat rate per sponsor', () => {
    expect(resolvePlanCredit(1)).toBe(500)
    expect(resolvePlanCredit(2)).toBe(1000)
    expect(resolvePlanCredit(3)).toBe(1500)
    expect(resolvePlanCredit(4)).toBe(2000)
    expect(resolvePlanCredit(5)).toBe(2500)
    expect(resolvePlanCredit(6)).toBe(3000)
  })

  it('earns from the FIRST sponsor — the new boundary', () => {
    // Previously zero. One sponsor is the count the old table could not reward.
    expect(resolvePlanCredit(1)).toBe(CREDIT_PER_SPONSOR_CENTS)
  })

  it('pays $15 at three sponsors — the guidebook-unlock milestone that used to pay nothing', () => {
    expect(resolvePlanCredit(3)).toBe(1500)
  })

  it('pays nothing at zero sponsors', () => {
    expect(resolvePlanCredit(0)).toBe(0)
  })

  it('never returns a positive credit for a negative or absurd count', () => {
    // A negative count is unreachable through getActiveSponsorCount, but a
    // negative credit here would become a positive CHARGE on the invoice —
    // the handler posts `amount: -planCreditCents`.
    expect(resolvePlanCredit(-1)).toBe(0)
    expect(resolvePlanCredit(-1000)).toBe(0)
    expect(resolvePlanCredit(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  it('has no cliffs — every sponsor is worth the same as the one before it', () => {
    // This is the whole point of the change. The old shape paid $0 for the
    // 4th sponsor and $15 for the 6th; a host could not predict either.
    for (let n = 1; n <= 6; n++) {
      expect(resolvePlanCredit(n) - resolvePlanCredit(n - 1)).toBe(CREDIT_PER_SPONSOR_CENTS)
    }
  })

  it('no count earns LESS than it did under the old two-step table', () => {
    // The migration guarantee: nobody's credit goes down. Old table was
    // 5 → $10, 6 → $25, everything else $0.
    const previous = (n: number) => (n >= 6 ? 2500 : n >= 5 ? 1000 : 0)
    for (let n = 0; n <= 6; n++) {
      expect(resolvePlanCredit(n)).toBeGreaterThanOrEqual(previous(n))
    }
  })

  it('stays well under the cheapest monthly plan at the slot ceiling', () => {
    // 6 is the schema cap (guidebook_sponsors_slot_number_check). $30 against
    // a $49 minimum plan means the credit cannot exceed an invoice today —
    // the assumption the handler's missing cap rests on.
    expect(resolvePlanCredit(6)).toBe(3000)
    expect(resolvePlanCredit(6)).toBeLessThan(4900)
  })
})
