// ============================================================================
// The marketing-facing plan table, in one place.
//
// components/ownerrez/PricingSection.tsx and components/hospitable/
// PricingSection.tsx were 274 and 281 lines that differed in TEN — the header
// comment, three feature bullets on the entry tier, and the provider slug in
// two href strings. The hospitable file said so itself: "Mirrors
// components/ownerrez/PricingSection.tsx by design ... Kept as a separate
// per-integration component to ... avoid touching the live OwnerRez page while
// this ships." That was a reasonable ship-it call whose reason has expired,
// and adding the Hosts tier meant writing the same 24 new lines into both,
// which is what SonarCloud flagged at 100% duplication on new code.
//
// ── Why this is a separate module from lib/stripe/client.ts's PLANS ─────────
//
// PLANS is the billing source of truth, but it lives next to `import Stripe
// from 'stripe'`. These are 'use client' landing pages, so importing it would
// pull the Stripe SDK into the browser bundle.
//
// So the numbers exist in two places by necessity, and
// unit/stripe/plan-table-consistency.test.ts is the bridge that will not let
// them disagree — it checks every price, property cap and advertised saving
// here against PLANS. Collapsing both onto one pure data module is the right
// end state; it means restructuring PLANS itself (carefully, since
// `PlanKey = keyof typeof PLANS` depends on it staying an object literal), and
// is deliberately not bundled into a duplication fix.
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

/**
 * The tiers above the entry plan. Identical on every landing page: they are
 * "Everything in <the tier below>" plus a property count, which is the whole
 * pitch — flat tier pricing, all features, no gates.
 *
 * Annual is monthly x 10 (two months free) and annualSavings is monthly x 2
 * throughout; the toggle's "Save 2 months" badge is only true because of it.
 */
const TIERS_ABOVE_ENTRY: readonly PricingTier[] = [
  {
    name: 'Starter',
    description: 'For independent managers with a focused portfolio.',
    monthly: 199,
    annual: 1990,
    annualSavings: 398,
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
    monthly: 479,
    annual: 4790,
    annualSavings: 958,
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
    monthly: 799,
    annual: 7990,
    annualSavings: 1598,
    properties: '51–100 properties',
    highlight: false,
    features: [
      'Everything in Growth',
      'Up to 100 properties',
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
    properties: '100+ properties',
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
      monthly: 89,
      annual: 890,
      annualSavings: 178,
      properties: '1–4 properties',
      highlight: false,
      features: [...entryFeatures],
    },
    ...TIERS_ABOVE_ENTRY,
  ]
}
