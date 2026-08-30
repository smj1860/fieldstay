import { describe, it, expect } from 'vitest'

import { pricingTiers, TIER_UPPER_BOUNDS } from '@/components/pricing/plan-tiers'
import { MAX_SELF_SERVE_PROPERTIES } from '@/lib/stripe/brackets'

// ============================================================================
// TIER_UPPER_BOUNDS is what lets PricingCards.tsx's calculator highlight the
// card matching whatever property count a visitor enters. It has to agree
// EXACTLY with the boundaries the cards' own `properties` strings describe —
// a drift here would highlight the wrong card for a real quantity, silently.
// ============================================================================

describe('TIER_UPPER_BOUNDS matches the tiers it is meant to index', () => {
  const tiers = pricingTiers(['x'])

  it('has one entry per priced tier, excluding Enterprise', () => {
    const pricedTiers = tiers.filter((t) => t.monthly !== null)
    expect(TIER_UPPER_BOUNDS).toHaveLength(pricedTiers.length)
  })

  it('the last bound is the self-serve ceiling, matching Portfolio', () => {
    expect(TIER_UPPER_BOUNDS.at(-1)).toBe(MAX_SELF_SERVE_PROPERTIES)
  })

  it('every bound is the exact upper edge of its tier\'s "properties" range', () => {
    // e.g. Starter's "5–15 properties" means TIER_UPPER_BOUNDS[1] must be 15.
    const upperEdges = tiers
      .filter((t) => t.monthly !== null)
      .map((t) => Number(t.properties.replace(/[^\d–]/g, '').split('–')[1]))

    expect([...TIER_UPPER_BOUNDS]).toEqual(upperEdges)
  })

  it('is strictly increasing, so findIndex-style lookups can\'t skip a band', () => {
    for (let i = 1; i < TIER_UPPER_BOUNDS.length; i++) {
      expect(TIER_UPPER_BOUNDS[i]).toBeGreaterThan(TIER_UPPER_BOUNDS[i - 1]!)
    }
  })
})
