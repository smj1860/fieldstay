// ============================================================================
// The pricing header/toggle + full PricingCards grid — the ONE real
// implementation. PricingSection.tsx (OwnerRez/Hospitable, which resolves a
// provider-tagged signup href) and this component's own two direct
// consumers (/pricing and /enterprise, which have no PMS context and no
// signup-href resolution to do) all render through here.
//
// PricingSection.tsx used to carry its own byte-for-byte copy of this same
// markup — a naive copy when /pricing and /enterprise were added is exactly
// how it got there, and SonarCloud caught it at 52%/43% duplication between
// the two files (2026-08-31) before PricingSection.tsx was collapsed into a
// thin wrapper over this one. See that file's header comment for the fuller
// history: this is the THIRD time this exact markup duplicated across files
// on this pricing surface (OwnerRez/Hospitable's own PricingSection.tsx
// pair, then PricingSection.tsx vs. this file), which is why the fix this
// time is a component every consumer shares rather than another copy.
// ============================================================================

'use client'

import { useState } from 'react'

import { pricingTiers } from './plan-tiers'
import PricingCards from './PricingCards'

interface GenericPricingSectionProps {
  /** Feature bullets for the entry (Hosts) tier — see PricingSection.tsx's identical prop. */
  entryFeatures: readonly string[]
  /** Defaults to a plain, provider-less signup — no PMS-connect query param. */
  signupHref?: string
}

export default function GenericPricingSection({
  entryFeatures,
  signupHref = '/signup?next=/onboarding',
}: Readonly<GenericPricingSectionProps>) {
  const [annual, setAnnual] = useState(false)

  const tiers = pricingTiers(entryFeatures)

  return (
    <div>
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold mb-3 text-[var(--mkt-ink)] font-display">
          We do business differently.
        </h2>
        <p className="text-[var(--mkt-muted)] mb-2">
          Simple, transparent pricing. 14-day free trial, no credit card required.
        </p>
        <p className="text-[var(--mkt-muted-strong)] text-sm mx-auto mb-6" style={{ maxWidth: 480 }}>
          Most STR software gates parts of the software behind higher tiers,
          or hits you with a steep jump the moment you add one more property.
          FieldStay doesn&apos;t. All the features, every tier. Add a
          property and the price moves a few dollars, never a cliff.
        </p>

        {/* Monthly / Annual toggle */}
        <div className="inline-flex items-center gap-1 bg-[var(--mkt-surface-alt)] border border-[var(--mkt-border)] rounded-full p-1">
          <button
            onClick={() => setAnnual(false)}
            aria-pressed={!annual}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all ${
              !annual
                ? 'bg-brand-800 text-white shadow-sm'
                : 'text-[var(--mkt-muted)] hover:text-[var(--mkt-ink)]'
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)}
            aria-pressed={annual}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all flex items-center gap-2 ${
              annual
                ? 'bg-brand-800 text-white shadow-sm'
                : 'text-[var(--mkt-muted)] hover:text-[var(--mkt-ink)]'
            }`}
          >
            Annual
            <span className="text-xs bg-[var(--mkt-gold)] text-[var(--mkt-ink)] px-2 py-0.5 rounded-full font-bold">
              Save 2 months
            </span>
          </button>
        </div>
      </div>

      {/* Plan cards — see PricingCards.tsx for the grid/card markup itself. */}
      <div className="mb-8">
        <PricingCards tiers={tiers} annual={annual} signupHref={signupHref} />
      </div>
    </div>
  )
}
