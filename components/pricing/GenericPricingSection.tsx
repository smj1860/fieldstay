// ============================================================================
// The pricing header/toggle + full PricingCards grid for a page with NO PMS
// context — /pricing and /enterprise. PricingSection.tsx (the OwnerRez/
// Hospitable component) is typed to `provider: "ownerrez" | "hospitable"`
// and builds its CTA as `/signup?provider=${provider}&next=/onboarding`,
// which has no correct value for a page that isn't selling against a PMS.
//
// This is a NEW component rather than widening PricingSection's provider
// union to include a null/generic case, specifically to avoid recreating the
// exact defect PricingSection.tsx's own header comment describes: two pages
// each hand-rolling a near-identical copy of this header/toggle markup would
// be the same class of duplication SonarCloud already flagged twice on this
// pricing surface (PricingSection itself, then the FAQ/JSON-LD builders).
// /pricing and /enterprise both import this ONE component instead.
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
