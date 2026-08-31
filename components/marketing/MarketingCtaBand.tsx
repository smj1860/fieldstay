// ============================================================================
// The dark-navy closing CTA band (h2 + subhead + CTA row + optional
// cross-link line) shared by /pricing and /enterprise — same duplication
// finding and same scoping rationale as MarketingHero.tsx in this directory.
// ============================================================================

import type { ReactNode } from 'react'

interface MarketingCtaBandProps {
  title: ReactNode
  subtitle: ReactNode
  /** The CTA row — one or more buttons/links, laid out in a flex row. */
  children: ReactNode
  /** Optional line below the CTA row, e.g. cross-links to related pages. */
  footer?: ReactNode
}

export default function MarketingCtaBand({ title, subtitle, children, footer }: Readonly<MarketingCtaBandProps>) {
  return (
    <section className="bg-[var(--mkt-ink)] text-white">
      <div className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h2 className="text-3xl font-bold mb-4 font-display">
          {title}
        </h2>
        <p className="text-[var(--mkt-on-dark-softer)] mb-8">
          {subtitle}
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
          {children}
        </div>
        {footer && (
          <p className="text-sm text-[var(--mkt-on-dark-soft)] mt-8">
            {footer}
          </p>
        )}
      </div>
    </section>
  )
}
