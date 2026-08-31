import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { read, readCode, ROOT } from '../guardrails/scan'

const HOMEPAGE       = join(ROOT, 'components/landing/homepage-content.tsx')
const PRICING_CARDS  = join(ROOT, 'components/pricing/PricingCards.tsx')

const page = read(HOMEPAGE)      // for prose assertions (visible copy)
const code = readCode(HOMEPAGE)  // for structural assertions — see note below

// ============================================================================
// The homepage's own pricing section is hand-rolled markup (not the shared
// components/pricing/PricingSection.tsx used by /ownerrez and /hospitable,
// and not app/hosts/page.tsx's 2-card layout), so it did not inherit either
// place's copy fix when billing moved from four flat-rate tiers to one
// graduated price (2026-08-29 rebuild, lib/stripe/brackets.ts). It sat there
// still claiming "Flat tier pricing" and rendering each card's price as a
// bare, unqualified `$X` — which for every band above Hosts is only true at
// the CHEAPEST property count in that band (plan-tiers.ts's BAND_FLOOR): a
// visitor reading "$98/mo" under "5–15 properties" and signing up at 15
// properties actually owes $188, not $98. See plan-tiers.ts's own header
// comment: "Every landing page that uses these numbers should say
// 'starting at', not imply a fixed rate."
//
// Fixed by folding the card grid into components/pricing/PricingCards.tsx,
// shared with PricingSection.tsx (/ownerrez, /hospitable) — this file
// asserted homepage-content.tsx actually USED that component, rather than
// re-checking price framing that no longer lived here.
//
// That import is gone now, on purpose: once /pricing shipped with the same
// PricingCards grid and calculator, indexing the whole thing at two URLs was
// duplicate content for no benefit — see homepage-content.tsx's own
// "Pricing teaser" section comment. What replaced it is a one-card
// "Starting at $X" teaser linking to /pricing, so the two tests that used to
// assert the PricingCards import now assert its ABSENCE and the /pricing
// link instead.
//
// The "no flat tier pricing" check runs against `code` (comments stripped),
// not `page` — this file's own header comment above talks about the retired
// "Flat tier pricing" phrase, and a raw string match against `page` would
// treat that prose as the very violation it describes. See
// unit/guardrails/scan.ts's header comment for why every guardrail that
// pattern-matches source must scan code, not comments.
// ============================================================================

describe('homepage pricing section reflects graduated pricing, not the retired flat-tier model', () => {
  it('does not claim flat tier pricing', () => {
    expect(code).not.toMatch(/flat tier pricing/i)
  })

  it('explains the graduated model rather than a flat-rate contrast', () => {
    // The corrected copy, ported from the already-fixed PricingSection.tsx —
    // asserting a substring rather than the whole paragraph so a rewording
    // doesn't fail this for no reason, while still pinning that the no-cliff
    // pitch (the actual differentiator that survived the rebuild) is present.
    expect(page).toContain('never')
    expect(page).toContain('a cliff')
  })

  it('no longer imports or renders PricingCards directly', () => {
    // Superseded by the /pricing page, which is the one place PricingCards'
    // full grid + calculator should be indexed now.
    expect(code).not.toContain("from '@/components/pricing/PricingCards'")
    expect(code).not.toMatch(/<PricingCards\s/)
  })

  it('links to /pricing for the full calculator and all plans', () => {
    expect(page).toMatch(/href="\/pricing"/)
  })
})

describe('the shared PricingCards component frames every price as a starting point', () => {
  const cards = readCode(PRICING_CARDS)

  it('prefixes the price with "from", never a bare $X', () => {
    expect(cards).toMatch(/from\{['"]? ?['"]?\}/)
  })
})
