// ============================================================================
// The pricing tier grid itself — five cards, one per PricingTier — extracted
// out of components/pricing/PricingSection.tsx so it can be shared by pages
// that want the cards but have their own header/copy/toggle around them.
//
// This split exists because components/landing/homepage-content.tsx had its
// own hand-rolled copy of this exact grid (same five tiers, same shape,
// different Tailwind classes) rather than importing PricingSection. That
// meant the graduated-pricing rebuild's "say 'from $X', not a bare '$X'"
// fix (see plan-tiers.ts's header comment) landed on /ownerrez and
// /hospitable but not the homepage, which kept rendering an unqualified
// price under a property-count range — misleading for anyone above the
// band's floor. A shared component makes that a fix-it-once problem instead
// of a fix-it-per-page one.
//
// app/hosts/page.tsx is NOT a consumer here on purpose: its 2-card layout
// (bigger cards, a solid-fill highlight on the ENTRY tier rather than
// Growth, no "Most Popular" ribbon) is a deliberately different comparison
// for a narrower funnel — not a copy of this grid that drifted, the way
// homepage-content.tsx's was. Folding it in would mean adding a variant
// prop to preserve a genuinely different design, not removing duplication.
// ============================================================================

import Link from "next/link";
import type { PricingTier } from "./plan-tiers";

interface PricingCardsProps {
  tiers:  readonly PricingTier[];
  annual: boolean;
  /**
   * Signup destination for every tier whose `monthly` is not null. The one
   * tier with `monthly === null` (Enterprise) always goes to a mailto
   * instead, regardless of this — there is no self-serve checkout for it.
   */
  signupHref: string;
}

export default function PricingCards({ tiers, annual, signupHref }: Readonly<PricingCardsProps>) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-6">
      {tiers.map((plan) => {
        // Computed once per card instead of re-branching on plan.highlight at
        // every single className — six identical ternary pairs used to be
        // spelled out inline, each one counted separately toward this map
        // callback's cognitive complexity.
        const cardClass    = plan.highlight ? "bg-brand-800 border-[var(--mkt-gold)]" : "bg-[var(--mkt-surface)] border-[var(--mkt-border)]"
        const primaryText  = plan.highlight ? "text-white" : "text-[var(--mkt-ink)]"
        const mutedText    = plan.highlight ? "text-[var(--mkt-on-dark-soft)]" : "text-[var(--mkt-muted)]"
        const featureText  = plan.highlight ? "text-[var(--mkt-on-dark-softer)]" : "text-[var(--mkt-muted)]"
        const propsBadge   = plan.highlight ? "bg-brand-panel text-[var(--mkt-on-dark-softer)]" : "bg-white border border-[var(--mkt-border)] text-[var(--mkt-ink)]"
        const ctaClass     = plan.highlight ? "bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)]" : "bg-brand-800 text-white hover:bg-[var(--mkt-ink-hover)]"

        return (
        <div
          key={plan.name}
          className={`rounded-2xl p-6 border relative flex flex-col ${cardClass}`}
        >
          {plan.highlight && (
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[var(--mkt-gold)] text-[var(--mkt-ink)] text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap">
              Most Popular
            </div>
          )}

          {/* Plan name + price */}
          <div className="mb-5">
            <div className={`font-bold text-lg mb-1 ${primaryText}`}>
              {plan.name}
            </div>

            <div className="flex items-end gap-1 mb-1 min-h-[48px]">
              {plan.monthly !== null ? (
                <>
                  <span className={`text-xs font-semibold mb-2 ${mutedText}`}>
                    from{' '}
                  </span>
                  <span className={`text-3xl font-bold ${primaryText}`}>
                    ${annual ? plan.annual!.toLocaleString() : plan.monthly}
                  </span>
                  <span className={`mb-1 text-sm ${mutedText}`}>
                    {annual ? '/yr' : '/mo'}
                  </span>
                </>
              ) : (
                <span className="text-3xl font-bold text-[var(--mkt-gold)]">
                  Custom
                </span>
              )}
            </div>

            <p className={`text-sm ${mutedText}`}>
              {plan.description}
            </p>

            <div className={`text-xs font-semibold mt-2 rounded-lg px-3 py-1.5 inline-block ${propsBadge}`}>
              {plan.properties}
            </div>
          </div>

          {/* Feature list */}
          <ul className="space-y-2.5 mb-6 flex-1">
            {plan.features.map((f) => (
              <li key={f} className={`flex items-center gap-2 text-sm ${featureText}`}>
                <svg
                  width="12"
                  height="10"
                  viewBox="0 0 12 10"
                  fill="none"
                  className="flex-shrink-0"
                >
                  <path
                    d="M1 5l4 4 6-8"
                    stroke="var(--mkt-gold)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {f}
              </li>
            ))}
          </ul>

          {/* CTA */}
          {plan.monthly !== null ? (
            <Link
              href={signupHref}
              className={`block text-center py-3 rounded-xl text-sm font-bold transition-colors ${ctaClass}`}
            >
              Start Free Trial
            </Link>
          ) : (
            <a
              href="mailto:hello@fieldstay.app"
              className="block text-center py-3 rounded-xl text-sm font-bold transition-colors bg-brand-800 text-white hover:bg-[var(--mkt-ink-hover)]"
            >
              Contact Us
            </a>
          )}
        </div>
        )
      })}
    </div>
  );
}
