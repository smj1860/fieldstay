// ============================================================================
// The PMS-specific (OwnerRez/Hospitable) pricing table.
//
// components/ownerrez/PricingSection.tsx and components/hospitable/
// PricingSection.tsx were 274 and 281 lines differing in TEN: the header
// comment, three feature bullets, and the provider slug in two hrefs. Adding
// the Hosts tier meant writing the same 24 new lines into both, which is what
// SonarCloud flagged at 100% duplication on new code. This file was the fix:
// the OwnerRez file's markup, unchanged, with the two genuine variables
// (provider, entryFeatures) becoming props.
//
// The markup itself now lives in ./GenericPricingSection.tsx, not here. When
// /pricing and /enterprise needed the same header/toggle/PricingCards grid
// with no provider context, a naive copy of this file's body would have
// recreated the EXACT defect described above a third time (SonarCloud caught
// it at 52%/43% duplication between this file and that one, 2026-08-31). This
// file is now a thin wrapper: it resolves the one thing that's actually
// provider-specific — the signup href — and hands everything else to the
// shared component.
//
// Plan data (prices, property ranges, the tiers above the entry plan) lives in
// ./plan-tiers.ts. See that file for why it is separate from
// lib/stripe/client.ts's PLANS, and which test stops the two from drifting.
// ============================================================================

'use client'

import GenericPricingSection from './GenericPricingSection'

interface PricingSectionProps {
  /** Drives the signup href. */
  provider: 'ownerrez' | 'hospitable'
  /**
   * Feature bullets for the ENTRY tier, which carries the complete list —
   * every tier above it reads "Everything in <the tier below>". The first
   * bullet names the PMS this page is selling against, which is the only
   * marketing copy that legitimately differs between the two pages.
   */
  entryFeatures: readonly string[]
}

export default function PricingSection({ provider, entryFeatures }: Readonly<PricingSectionProps>) {
  // Always the signup href. The logged-in `/api/integrations/{provider}/connect`
  // branch was unreachable: the pages that render this stopped resolving a
  // session on 2026-08-19 (it forced dynamic rendering on a page whose whole
  // job is to be fetched by strangers), so the prop arrived hardcoded false.
  // A signed-in visitor following this lands on /signup, which proxy.ts
  // redirects to /ops — so nothing is lost but a shortcut.
  const ctaHref = `/signup?provider=${provider}&next=/onboarding`

  return <GenericPricingSection entryFeatures={entryFeatures} signupHref={ctaHref} />
}
