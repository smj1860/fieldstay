import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const page = read('components/landing/homepage-content.tsx')

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
// ============================================================================

describe('homepage pricing section reflects graduated pricing, not the retired flat-tier model', () => {
  it('does not claim flat tier pricing', () => {
    expect(page).not.toMatch(/flat tier pricing/i)
  })

  it('frames the price as a starting point ("from"), not a flat number', () => {
    // Mirrors the "from $X" prefix already used by app/hosts/page.tsx and
    // components/pricing/PricingSection.tsx for the exact same reason.
    expect(page).toMatch(/from\{['"]? ?['"]?\}/)
  })

  it('explains the graduated model rather than a flat-rate contrast', () => {
    // The corrected copy, ported from the already-fixed PricingSection.tsx —
    // asserting a substring rather than the whole paragraph so a rewording
    // doesn't fail this for no reason, while still pinning that "flat" is
    // gone and the no-cliff pitch (the actual differentiator that survived
    // the rebuild) is present.
    expect(page).toContain('never')
    expect(page).toContain('a cliff')
  })
})
