import { monthlyCostCents, annualCostCents, MAX_SELF_SERVE_PROPERTIES } from '@/lib/stripe/brackets'

// ============================================================================
// The marketing-facing plan table, in one place.
//
// components/ownerrez/PricingSection.tsx and components/hospitable/
// PricingSection.tsx were 274 and 281 lines that differed in TEN — the header
// comment, three feature bullets on the entry tier, and the provider slug in
// two href strings. Collapsed here (see git history for the original
// duplication finding); this module is what both — and app/hosts/page.tsx's
// 2-card layout — actually pull their numbers from.
//
// ── Graduated pricing, not flat tiers (2026-08-29 rebuild) ──────────────────
//
// FieldStay billing moved from 4 flat-rate Stripe Products to ONE graduated
// (marginal) price per interval: $49 for the first property, then $13/$10/$8/
// $6 per property for brackets 2-4/5-15/16-50/51-150 (lib/stripe/brackets.ts
// is the actual billing source of truth this page's numbers are computed
// from). There is no longer a single flat number that is "the price" for a
// 1-4 or 5-15 property operation — cost is continuous within every band.
//
// These cards keep the old property-range framing (still a useful way to
// segment the pitch by operation size) but each one now shows its STARTING
// price — the true cost of the FIRST property in that band, computed via
// monthlyCostCents(). That number is always literally achievable and never
// overstates what a visitor in that band would pay; it is not a flat
// guarantee the way the old numbers were. Every landing page that uses these
// numbers should say "starting at", not imply a fixed rate — the "FieldStay
// plan is flat" pitch from the old model is gone along with the flat prices.
//
// A real redesign — a calculator that computes the exact price for the
// visitor's own count, shown alongside these cards rather than instead of
// them — represents the pricing model more honestly than four bounded cards
// ever can on their own, since the underlying curve is continuous. That
// calculator now exists (PricingCards.tsx renders it above the grid); this
// module's job is still to make sure nothing on the marketing site quotes a
// number disconnected from what Stripe will actually charge — TIER_UPPER_BOUNDS
// below is what lets the calculator highlight which of these cards its
// answer falls into, computed from the same numbers the cards themselves use
// rather than a second set of hardcoded boundaries.
//
// Annual is monthly x 10 (two months free) and annualSavings is monthly x 2
// throughout, computed via annualCostCents() from the same bracket schedule —
// the toggle's "Save 2 months" badge is only true because of it.
// ============================================================================

export interface PricingTier {
  name:          string
  description:   string
  monthly:       number | null
  annual:        number | null
  annualSavings: number | null
  properties:    string
  highlight:     boolean
  features:      string[]
}

/** The lowest property count in each band — what "starting at" is computed from. */
const BAND_FLOOR = { starter: 5, growth: 16, portfolio: 51 } as const

/**
 * The highest property count each of the four PRICED tiers covers, in the
 * same order `pricingTiers()` returns them (Hosts, Starter, Growth,
 * Portfolio) — Enterprise has no upper bound so it is not represented here.
 * `qty <= TIER_UPPER_BOUNDS[i]` is "this quantity's card is tier i", used by
 * PricingCards.tsx's calculator to highlight the matching card rather than
 * leaving the two side by side with no visible connection.
 *
 * Derived from BAND_FLOOR and MAX_SELF_SERVE_PROPERTIES rather than typed out
 * again — a second hardcoded [4, 15, 50, 150] here is exactly the kind of
 * disconnected number this file exists to prevent.
 */
export const TIER_UPPER_BOUNDS: readonly number[] = [
  BAND_FLOOR.starter - 1,
  BAND_FLOOR.growth - 1,
  BAND_FLOOR.portfolio - 1,
  MAX_SELF_SERVE_PROPERTIES,
]

/**
 * The tiers above the entry plan. Identical on every landing page: they are
 * "Everything in <the tier below>" plus a property count, which is the whole
 * pitch — one graduated price, all features, no gates.
 */
const TIERS_ABOVE_ENTRY: readonly PricingTier[] = [
  {
    name: 'Starter',
    description: 'For independent managers with a focused portfolio.',
    monthly: monthlyCostCents(BAND_FLOOR.starter)! / 100,
    annual:  annualCostCents(BAND_FLOOR.starter)! / 100,
    annualSavings: (monthlyCostCents(BAND_FLOOR.starter)! / 100) * 2,
    properties: '5–15 properties',
    highlight: false,
    features: [
      'Everything in Hosts',
      'Up to 15 properties',
    ],
  },
  {
    name: 'Growth',
    description: 'For expanding operations that need more scale.',
    monthly: monthlyCostCents(BAND_FLOOR.growth)! / 100,
    annual:  annualCostCents(BAND_FLOOR.growth)! / 100,
    annualSavings: (monthlyCostCents(BAND_FLOOR.growth)! / 100) * 2,
    properties: '16–50 properties',
    highlight: true,
    features: [
      'Everything in Starter',
      'Up to 50 properties',
      'Priority support',
    ],
  },
  {
    name: 'Portfolio',
    description: 'For professional managers running a full operation.',
    monthly: monthlyCostCents(BAND_FLOOR.portfolio)! / 100,
    annual:  annualCostCents(BAND_FLOOR.portfolio)! / 100,
    annualSavings: (monthlyCostCents(BAND_FLOOR.portfolio)! / 100) * 2,
    // Derived rather than typed out — a hand-typed "51–100" is exactly the
    // kind of second copy that went stale when the ceiling widened to 150.
    properties: `${BAND_FLOOR.portfolio}–${MAX_SELF_SERVE_PROPERTIES} properties`,
    highlight: false,
    features: [
      'Everything in Growth',
      `Up to ${MAX_SELF_SERVE_PROPERTIES} properties`,
      'Custom onboarding',
      'Dedicated account support',
    ],
  },
  {
    name: 'Enterprise',
    description: 'For large portfolios and multi-location operations.',
    monthly: null,
    annual: null,
    annualSavings: null,
    properties: `${MAX_SELF_SERVE_PROPERTIES + 1}+ properties`,
    highlight: false,
    features: [
      'Everything in Portfolio',
      'Unlimited properties',
      'SLA-backed uptime',
      'Volume pricing',
    ],
  },
]

/**
 * The full tier list for one landing page.
 *
 * Only the ENTRY tier's feature bullets vary by integration — that card
 * carries the complete feature list (every tier above it reads "Everything
 * in …"), and the first bullet names the PMS the page is selling against.
 * Everything else, prices included, is shared.
 */
export function pricingTiers(entryFeatures: readonly string[]): PricingTier[] {
  return [
    {
      name: 'Hosts',
      description: 'For hosts running a handful of listings.',
      // The site-wide anchor — property 1's flat $49, the true minimum price
      // of any FieldStay subscription. Unlike the bands above, this IS the
      // literal starting point of the whole schedule, not just this band's.
      monthly: monthlyCostCents(1)! / 100,
      annual:  annualCostCents(1)! / 100,
      annualSavings: (monthlyCostCents(1)! / 100) * 2,
      properties: '1–4 properties',
      highlight: false,
      features: [...entryFeatures],
    },
    ...TIERS_ABOVE_ENTRY,
  ]
}

/**
 * The intersection of what every integration landing page promises, with no
 * wording naming a specific PMS as the sales hook. Shared by /pricing and
 * /enterprise — both GenericPricingSection consumers with no PMS context of
 * their own — which is why this lives here rather than duplicated in each
 * page: the two copies were byte-identical and SonarCloud flagged it as
 * duplication on new code (2026-08-31). OwnerRez/Hospitable's own
 * PricingSection.tsx pages pass PMS-specific bullets instead, naming the
 * competitor being sold against in the first line.
 */
export const GENERIC_ENTRY_FEATURES = [
  'iCal sync (Airbnb, VRBO) — or connect OwnerRez/Hospitable',
  'Offline-ready crew app with photo capture',
  'No-login vendor work order portal',
  'Inventory with auto-restock',
  'Maintenance scheduling',
  'Owner P&L portal',
  'RepuGuard reputation management',
] as const
