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
import { monthlyCostCents } from '@/lib/stripe/brackets'

// ============================================================================
// Flat $5 per active sponsor, per month, from the first one — capped at the
// cost of the plan the org is on.
//
// Two shapes are pinned here, and they matter for different reasons:
//
//   * NO CLIFFS below the cap. This replaced a two-step threshold
//     (5 → $10, 6 → $25) that paid nothing for a 4th sponsor; every
//     additional sponsor must be worth exactly the same as the one before it.
//   * A REAL CAP above it. Sponsors used to be bounded at 6 by
//     guidebook_sponsors_slot_number_check, which kept the credit under $30
//     and under the cheapest plan. 20260909234738_uncap_guidebook_sponsor_
//     slots.sql removed that ceiling, so the cap is the only thing standing
//     between an org with 40 sponsors and a credit larger than its invoice —
//     which Stripe would carry forward as customer balance indefinitely
//     rather than simply zeroing the bill.
// ============================================================================

/** A cap high enough never to bind — for the tests about the rate itself. */
const UNCAPPED = 1_000_000

describe('resolvePlanCredit', () => {
  it('pays a flat rate per sponsor', () => {
    expect(resolvePlanCredit(1, UNCAPPED)).toBe(500)
    expect(resolvePlanCredit(2, UNCAPPED)).toBe(1000)
    expect(resolvePlanCredit(3, UNCAPPED)).toBe(1500)
    expect(resolvePlanCredit(4, UNCAPPED)).toBe(2000)
    expect(resolvePlanCredit(5, UNCAPPED)).toBe(2500)
    expect(resolvePlanCredit(6, UNCAPPED)).toBe(3000)
  })

  it('earns from the FIRST sponsor — the new boundary', () => {
    // Previously zero. One sponsor is the count the old table could not reward.
    expect(resolvePlanCredit(1, UNCAPPED)).toBe(CREDIT_PER_SPONSOR_CENTS)
  })

  it('pays $15 at three sponsors — the guidebook-unlock milestone that used to pay nothing', () => {
    expect(resolvePlanCredit(3, UNCAPPED)).toBe(1500)
  })

  it('pays nothing at zero sponsors', () => {
    expect(resolvePlanCredit(0, UNCAPPED)).toBe(0)
  })

  it('never returns a positive credit for a negative or absurd count', () => {
    // A negative count is unreachable through getActiveSponsorCount, but a
    // negative credit here would become a positive CHARGE on the invoice —
    // the handler posts `amount: -planCreditCents`.
    expect(resolvePlanCredit(-1, UNCAPPED)).toBe(0)
    expect(resolvePlanCredit(-1000, UNCAPPED)).toBe(0)
    expect(resolvePlanCredit(Number.NEGATIVE_INFINITY, UNCAPPED)).toBe(0)
  })

  it('has no cliffs — every sponsor is worth the same as the one before it', () => {
    // This is the whole point of the change. The old shape paid $0 for the
    // 4th sponsor and $15 for the 6th; a host could not predict either.
    for (let n = 1; n <= 6; n++) {
      expect(resolvePlanCredit(n, UNCAPPED) - resolvePlanCredit(n - 1, UNCAPPED)).toBe(CREDIT_PER_SPONSOR_CENTS)
    }
  })

  it('no count earns LESS than it did under the old two-step table', () => {
    // The migration guarantee: nobody's credit goes down. Old table was
    // 5 → $10, 6 → $25, everything else $0.
    const previous = (n: number) => (n >= 6 ? 2500 : n >= 5 ? 1000 : 0)
    for (let n = 0; n <= 6; n++) {
      expect(resolvePlanCredit(n, UNCAPPED)).toBeGreaterThanOrEqual(previous(n))
    }
  })

  it('never credits more than the plan costs', () => {
    // The cap that became mandatory when the 6-sponsor ceiling was dropped.
    // 40 sponsors earn $200; a 5-property plan costs $68. The org is credited
    // $68 — its bill floors at zero and the surplus is NOT carried forward.
    const fiveProperties = monthlyCostCents(5)!
    expect(fiveProperties).toBe(6_800)
    expect(resolvePlanCredit(40, fiveProperties)).toBe(fiveProperties)
  })

  it('credits the full earned amount whenever it fits under the plan cost', () => {
    // The cap must not clip a credit that was always affordable — the common
    // case, and the one a naive Math.min could get wrong by capping at the
    // wrong figure.
    const oneProperty = monthlyCostCents(1)!
    expect(oneProperty).toBe(1_900)
    expect(resolvePlanCredit(3, oneProperty)).toBe(1_500)
  })

  it('is exactly the plan cost at the break-even sponsor count, never a cent more', () => {
    // The boundary. At $19 and $5/sponsor, 4 sponsors is $20 — the first
    // count that exceeds a single-property plan.
    const oneProperty = monthlyCostCents(1)!
    expect(resolvePlanCredit(3,  oneProperty)).toBe(1_500)
    expect(resolvePlanCredit(4,  oneProperty)).toBe(oneProperty)
    expect(resolvePlanCredit(99, oneProperty)).toBe(oneProperty)
  })

  it('credits nothing when the plan cost could not be resolved', () => {
    // The handler passes null through as a skip rather than calling this, but
    // a zero/negative/NaN cap reaching here must not be read as "unlimited".
    // Crediting on an unknown cap is money out the door; skipping a cycle is
    // recoverable.
    expect(resolvePlanCredit(5, 0)).toBe(0)
    expect(resolvePlanCredit(5, -100)).toBe(0)
    expect(resolvePlanCredit(5, Number.NaN)).toBe(0)
    expect(resolvePlanCredit(5, Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('never returns a negative credit — the handler posts the NEGATION of this', () => {
    // `amount: -planCreditCents`, so a negative here becomes a CHARGE.
    for (const [count, cap] of [[40, 6_800], [1, 1_900], [0, 1_900], [-5, 1_900]] as const) {
      expect(resolvePlanCredit(count, cap)).toBeGreaterThanOrEqual(0)
    }
  })
})
