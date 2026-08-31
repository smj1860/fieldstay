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
// That full grid is GONE now, on purpose — once /pricing shipped with the
// same PricingCards grid and calculator, indexing the whole thing at two
// URLs was duplicate content for no benefit (see homepage-content.tsx's own
// "Pricing teaser" section comment). What remains is a one-card "Starting
// at $X" teaser linking to /pricing, and what follows tests THAT, not the
// grid this describe block used to render — plus the two other sections
// added in the same original pass, which have no other coverage at all.
// ============================================================================

describe('homepage pricing teaser', () => {
  it('shows the real Hosts-tier starting price, not a hardcoded number', () => {
    render(<HomepageContent />)
    const [hosts] = pricingTiers(['x'])
    expect(screen.getAllByText(`$${hosts.monthly}`, { exact: false }).length).toBeGreaterThan(0)
  })

  it('links to /pricing for the full calculator and all plans', () => {
    render(<HomepageContent />)
    const link = screen.getByRole('link', { name: /See the full calculator/i })
    expect(link).toHaveAttribute('href', '/pricing')
  })

  it('no longer renders the full five-tier grid', () => {
    render(<HomepageContent />)
    // PricingCards.tsx's own badge text for the Growth tier specifically —
    // its absence is what confirms the grid itself, not just some of its
    // copy, is gone. ("Enterprise" alone isn't a safe check here: it's also
    // a real footer link now.)
    expect(screen.queryByText('Most Popular')).not.toBeInTheDocument()
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
