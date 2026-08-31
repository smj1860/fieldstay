// ============================================================================
// The dark-navy hero (eyebrow + h1 + subhead + CTA row) shared by /pricing
// and /enterprise. Both pages started as independent copies of this exact
// shape — SonarCloud flagged 43%/17% duplication between them (2026-08-31)
// on top of the larger GenericPricingSection/PricingSection finding.
//
// Scoped to these two pages only, not retrofitted onto /strops,
// /breezeway-alternative, /hosts, /ownerrez, or /hospitable — those five
// predate this component, are already shipped and correct, and were not
// flagged (their hero shapes have diverged enough from each other, and from
// these two, to fall under Sonar's duplication threshold). Retrofitting them
// would be a larger, riskier change than what the actual finding called for.
// ============================================================================

import type { ReactNode } from 'react'

interface MarketingHeroProps {
  eyebrow: string
  title: ReactNode
  subtitle: ReactNode
  /** The CTA row — one or more buttons/links, laid out in a flex row. */
  children: ReactNode
}

export default function MarketingHero({ eyebrow, title, subtitle, children }: Readonly<MarketingHeroProps>) {
  return (
    <section className="bg-[var(--mkt-ink)] text-white">
      <div className="max-w-3xl mx-auto px-6 py-20 text-center">
        <p className="text-xs font-bold tracking-[0.16em] uppercase text-[var(--mkt-gold)] mb-4">
          {eyebrow}
        </p>
        <h1 className="text-4xl sm:text-5xl font-bold mb-5 font-display leading-tight">
          {title}
        </h1>
        <p className="text-lg text-[var(--mkt-on-dark-softer)] max-w-2xl mx-auto mb-9">
          {subtitle}
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
          {children}
        </div>
      </div>
    </section>
  )
}
