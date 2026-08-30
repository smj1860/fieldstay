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
// shared with PricingSection.tsx (/ownerrez, /hospitable) — so this file now
// asserts homepage-content.tsx actually USES that component rather than
// re-checking price framing that no longer lives here.
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

  it('renders the shared PricingCards component instead of its own card grid', () => {
    // The concrete bug: this page used to hand-roll a second copy of the same
    // five-card grid PricingSection.tsx already rendered elsewhere, so the
    // "from $X" framing fix landed on /ownerrez and /hospitable but not here.
    // Importing the shared component makes that a fix-it-once problem.
    expect(code).toContain("import PricingCards from '@/components/pricing/PricingCards'")
    expect(code).toMatch(/<PricingCards\s/)
  })

  it('passes the homepage-specific signup href, not a provider-scoped one', () => {
    // The homepage doesn't sell against a specific PMS, unlike /ownerrez and
    // /hospitable — it must not carry a `provider=` query param.
    expect(code).toMatch(/signupHref=["']\/signup["']/)
  })
})

describe('the shared PricingCards component frames every price as a starting point', () => {
  const cards = readCode(PRICING_CARDS)

  it('prefixes the price with "from", never a bare $X', () => {
    expect(cards).toMatch(/from\{['"]? ?['"]?\}/)
  })
})
