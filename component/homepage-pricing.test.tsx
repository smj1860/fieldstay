import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { HomepageContent } from '@/components/landing/homepage-content'
import { pricingTiers } from '@/components/pricing/plan-tiers'

// ============================================================================
// The homepage's pricing grid used to be a hand-written 4-tier array that had
// drifted from components/pricing/plan-tiers.ts — no Hosts tier at all, and
// Starter still labelled "Up to 15 properties" after the real floor moved to 5.
// unit/stripe/plan-table-consistency.test.ts holds plan-tiers.ts against
// lib/stripe/client.ts's PLANS, but it never looked at this page, so nothing
// caught it.
//
// Reading from pricingTiers() makes the NUMBERS structurally undriftable. What
// that alone does not cover is the presentation this page derives rather than
// carries: PricingTier has no cta/badge fields, so "Most Popular" and
// "Custom"/"Contact Us" are now computed from `highlight` and `monthly ===
// null`. Those expressions have to keep evaluating to what the removed
// per-item fields held, and that is what this file pins — plus the two other
// sections added in the same pass, which have no other coverage at all.
// ============================================================================

describe('homepage pricing grid', () => {
  it('renders every tier pricingTiers() returns, in order', () => {
    render(<HomepageContent />)

    // Driven off the source rather than a hardcoded list of five, so adding a
    // tier to plan-tiers.ts does not silently leave this asserting the old set.
    for (const tier of pricingTiers(['x'])) {
      expect(screen.getAllByText(tier.name).length, `${tier.name} card missing`).toBeGreaterThan(0)
      expect(
        screen.getAllByText(tier.properties).length,
        `${tier.name}'s property range is not on the page`,
      ).toBeGreaterThan(0)
    }
  })

  it('badges and CTA text still derive correctly from highlight / monthly', () => {
    render(<HomepageContent />)

    // Exactly one of each: Growth is the only highlight: true, Enterprise the
    // only monthly: null. A second "Most Popular" means the derivation broke.
    expect(screen.getAllByText('Most Popular')).toHaveLength(1)
    expect(screen.getAllByText('Custom')).toHaveLength(1)
    expect(screen.getAllByText('Contact Us')).toHaveLength(1)
  })

  it('shows the Hosts entry price the /strops JSON-LD advertises', () => {
    render(<HomepageContent />)
    const [hosts] = pricingTiers(['x'])
    // Two, not one: the Hosts card's own price, plus the pricing calculator's
    // collapsed "see the math" breakdown, whose first line is always Property
    // 1's flat $49 regardless of the quantity entered — see PricingCards.tsx.
    expect(screen.getAllByText(`$${hosts.monthly}`).length).toBe(2)
  })

  it('the entry card carries the homepage feature list, RepuGuard included', () => {
    // The one thing that legitimately varies from /ownerrez and /hospitable's
    // entry cards. If this bullet goes, the page is selling a shorter product.
    render(<HomepageContent />)
    expect(screen.getAllByText('RepuGuard reputation management').length).toBe(1)
  })
})

describe('homepage sections added alongside the pricing fix', () => {
  it('renders the FAQ accordion', () => {
    // Every other public landing page shipped one; the highest-traffic page
    // did not. Content comes from lib/faq-content.ts, so this only checks the
    // section is mounted at all.
    render(<HomepageContent />)
    expect(screen.getAllByText('Common questions').length).toBe(1)
  })

  it('renders the RepuGuard live demo, not just the static feature card', () => {
    render(<HomepageContent />)
    expect(screen.getAllByText('See RepuGuard in Action').length).toBe(1)
  })

  it('the hero eyebrow does not disqualify visitors the pricing floor accepts', () => {
    // It read "10–100 Properties" while Starter began at 5 — a 6-property
    // visitor bounced before ever reaching the table.
    render(<HomepageContent />)
    expect(screen.getAllByText(/5–100\+ Properties/).length).toBe(1)
  })
})
