import { describe, it, expect } from 'vitest'

import {
  BRACKETS,
  ANNUAL_MULTIPLIER,
  MAX_SELF_SERVE_PROPERTIES,
  monthlyCostCents,
  annualCostCents,
  toStripeTiers,
  marginalRateCentsFor,
  bracketBreakdown,
} from '@/lib/stripe/brackets'

// ============================================================================
// This schedule replaces the old 4-tier flat PLANS pricing (lib/stripe/
// client.ts) specifically to remove the $110-$320 cliff a customer hit the
// moment their property count crossed a tier boundary. The locked numbers
// below (anchor $49, then $13/$10/$8/$6 per unit for brackets 2-4/5-15/16-50/
// 51-100) were chosen to be revenue-neutral, within a dollar, at every OLD
// tier's ceiling (4/15/50/100 properties) and strictly cheaper everywhere
// else — never re-derive or "improve" these numbers without going back to
// that design decision; they are a deliberate margin-for-adoption trade, not
// a default that happened to fall out of the math.
// ============================================================================

describe('graduated pricing bracket schedule', () => {
  it('matches the locked schedule exactly', () => {
    expect(BRACKETS).toEqual([
      { upTo: 1,   flatAmountCents: 4_900 },
      { upTo: 4,   unitAmountCents: 1_300 },
      { upTo: 15,  unitAmountCents: 1_000 },
      { upTo: 50,  unitAmountCents: 800 },
      { upTo: 100, unitAmountCents: 600 },
    ])
  })

  it('caps self-serve pricing at 100 properties — above that is Enterprise/contact-sales', () => {
    expect(MAX_SELF_SERVE_PROPERTIES).toBe(100)
    expect(monthlyCostCents(101)).toBeNull()
  })

  it('rejects zero and non-integer quantities', () => {
    expect(monthlyCostCents(0)).toBeNull()
    expect(monthlyCostCents(-1)).toBeNull()
    expect(monthlyCostCents(2.5)).toBeNull()
  })

  it('property 1 costs exactly the $49 anchor, flat', () => {
    expect(monthlyCostCents(1)).toBe(4_900)
  })

  // The exact cumulative totals the design negotiation locked in — each is
  // "revenue-neutral within a dollar" against the OLD flat plan at that same
  // ceiling (Hosts $89, Starter $199, Growth $479, Portfolio $799).
  it.each([
    [4,   8_800],
    [15,  19_800],
    [50,  47_800],
    [100, 77_800],
  ])('totals $%i.xx at the old ceiling of %i properties', (quantity, expectedCents) => {
    expect(monthlyCostCents(quantity)).toBe(expectedCents)
  })

  it('is graduated, not cliffed: crossing a boundary only re-rates the units past it', () => {
    // Property 5 alone costs $10 more than property 4 would have under its
    // OWN bracket rate — not a jump in what properties 1-4 cost.
    const at4 = monthlyCostCents(4)!
    const at5 = monthlyCostCents(5)!
    expect(at5 - at4).toBe(1_000)
  })

  it('is monotonically increasing — one more property never lowers the bill', () => {
    for (let q = 2; q <= MAX_SELF_SERVE_PROPERTIES; q++) {
      expect(monthlyCostCents(q)).toBeGreaterThan(monthlyCostCents(q - 1)!)
    }
  })

  it('annual is exactly monthly x10 at every quantity — the same "2 months free" convention as the old PLANS table', () => {
    expect(ANNUAL_MULTIPLIER).toBe(10)
    for (const q of [1, 4, 15, 50, 100]) {
      expect(annualCostCents(q)).toBe(monthlyCostCents(q)! * 10)
    }
  })

  it('annual returns null for the same out-of-range quantities as monthly', () => {
    expect(annualCostCents(0)).toBeNull()
    expect(annualCostCents(101)).toBeNull()
  })

  it('marginalRateCentsFor reports the anchor for quantity 1 and each bracket rate above it', () => {
    expect(marginalRateCentsFor(1)).toBe(4_900)
    expect(marginalRateCentsFor(2)).toBe(1_300)
    expect(marginalRateCentsFor(4)).toBe(1_300)
    expect(marginalRateCentsFor(5)).toBe(1_000)
    expect(marginalRateCentsFor(16)).toBe(800)
    expect(marginalRateCentsFor(51)).toBe(600)
    expect(marginalRateCentsFor(101)).toBeNull()
  })

  describe('bracketBreakdown', () => {
    it('returns [] for out-of-range quantities', () => {
      expect(bracketBreakdown(0)).toEqual([])
      expect(bracketBreakdown(101)).toEqual([])
    })

    it('is just the anchor at quantity 1', () => {
      expect(bracketBreakdown(1)).toEqual([
        { label: 'Property 1', units: 1, amountCents: 4_900, lineTotalCents: 4_900 },
      ])
    })

    it('breaks down quantity 4 into the anchor plus the 2-4 bracket', () => {
      expect(bracketBreakdown(4)).toEqual([
        { label: 'Property 1', units: 1, amountCents: 4_900, lineTotalCents: 4_900 },
        { label: 'Properties 2–4', units: 3, amountCents: 1_300, lineTotalCents: 3_900 },
      ])
    })

    it('labels a single-unit line as one property, not a range', () => {
      const lines = bracketBreakdown(5)
      const fifth = lines.find((l) => l.units === 1 && l.amountCents === 1_000)
      expect(fifth?.label).toBe('Property 5')
    })

    it('every line sums to monthlyCostCents at the same quantity', () => {
      for (const q of [1, 4, 5, 15, 16, 50, 51, 100]) {
        const lines = bracketBreakdown(q)
        const sum = lines.reduce((acc, l) => acc + l.lineTotalCents, 0)
        expect(sum, `quantity ${q}`).toBe(monthlyCostCents(q))
      }
    })

    it('scales every line by 10x for annual, from the same schedule', () => {
      const monthly = bracketBreakdown(4, 'monthly')
      const annual  = bracketBreakdown(4, 'annual')
      expect(annual).toEqual(monthly.map((l) => ({
        ...l,
        amountCents:    l.amountCents * 10,
        lineTotalCents: l.lineTotalCents * 10,
      })))
    })
  })

  describe('toStripeTiers', () => {
    it('produces a monthly tiers array Stripe accepts for a graduated price', () => {
      // The last tier's up_to is the literal string 'inf', not 100 — Stripe
      // rejects a graduated tiers array whose last element isn't the 'inf'
      // catch-all ("The tiers array must include a catch all tier with
      // up_to set to `inf` as last item"), discovered by actually creating
      // the live Price. 100 (MAX_SELF_SERVE_PROPERTIES) is still the real
      // self-serve ceiling enforced everywhere else in the app.
      expect(toStripeTiers('monthly')).toEqual([
        { up_to: 1,   flat_amount: 4_900 },
        { up_to: 4,   unit_amount: 1_300 },
        { up_to: 15,  unit_amount: 1_000 },
        { up_to: 50,  unit_amount: 800 },
        { up_to: 'inf', unit_amount: 600 },
      ])
    })

    it('scales every amount by 10x for annual, from the SAME BRACKETS array', () => {
      expect(toStripeTiers('annual')).toEqual([
        { up_to: 1,   flat_amount: 49_000 },
        { up_to: 4,   unit_amount: 13_000 },
        { up_to: 15,  unit_amount: 10_000 },
        { up_to: 50,  unit_amount: 8_000 },
        { up_to: 'inf', unit_amount: 6_000 },
      ])
    })

    it('never emits both flat_amount and unit_amount on the same tier', () => {
      for (const interval of ['monthly', 'annual'] as const) {
        for (const tier of toStripeTiers(interval)) {
          const hasFlat = 'flat_amount' in tier
          const hasUnit = 'unit_amount' in tier
          expect(hasFlat !== hasUnit, `tier up_to=${tier.up_to} must have exactly one of flat_amount/unit_amount`).toBe(true)
        }
      }
    })
  })
})
