// ============================================================================
// The shared landing-page pricing table.
//
// components/ownerrez/PricingSection.tsx and components/hospitable/
// PricingSection.tsx were 274 and 281 lines differing in TEN: the header
// comment, three feature bullets, and the provider slug in two hrefs. Adding
// the Hosts tier meant writing the same 24 new lines into both, which is what
// SonarCloud flagged at 100% duplication on new code.
//
// The markup below is the OwnerRez file's, unchanged — this is an extraction,
// not a redesign, so neither live page shifts by a pixel. The only edits are
// the two genuine variables becoming props.
//
// Plan data (prices, property ranges, the tiers above the entry plan) lives in
// ./plan-tiers.ts. See that file for why it is separate from
// lib/stripe/client.ts's PLANS, and which test stops the two from drifting.
// ============================================================================

"use client";

import { useState } from "react";
import Link from "next/link";

import { pricingTiers } from "./plan-tiers";

interface PricingSectionProps {
  /** Drives the signup href. */
  provider: "ownerrez" | "hospitable";
  /**
   * Feature bullets for the ENTRY tier, which carries the complete list —
   * every tier above it reads "Everything in <the tier below>". The first
   * bullet names the PMS this page is selling against, which is the only
   * marketing copy that legitimately differs between the two pages.
   */
  entryFeatures: readonly string[];
}

export default function PricingSection({ provider, entryFeatures }: Readonly<PricingSectionProps>) {
  const [annual, setAnnual] = useState(false);

  const tiers = pricingTiers(entryFeatures);

  // Always the signup href. The logged-in `/api/integrations/{provider}/connect`
  // branch was unreachable: the pages that render this stopped resolving a
  // session on 2026-08-19 (it forced dynamic rendering on a page whose whole
  // job is to be fetched by strangers), so the prop arrived hardcoded false.
  // A signed-in visitor following this lands on /signup, which proxy.ts
  // redirects to /ops — so nothing is lost but a shortcut.
  const ctaHref = `/signup?provider=${provider}&next=/onboarding`;

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
                ? "bg-brand-800 text-white shadow-sm"
                : "text-[var(--mkt-muted)] hover:text-[var(--mkt-ink)]"
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)}
            aria-pressed={annual}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all flex items-center gap-2 ${
              annual
                ? "bg-brand-800 text-white shadow-sm"
                : "text-[var(--mkt-muted)] hover:text-[var(--mkt-ink)]"
            }`}
          >
            Annual
            <span className="text-xs bg-[var(--mkt-gold)] text-[var(--mkt-ink)] px-2 py-0.5 rounded-full font-bold">
              Save 2 months
            </span>
          </button>
        </div>
      </div>

      {/* Plan cards — 5 tiers: 5-col at 2xl, 3-col at lg, 2-col tablet, 1-col mobile */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-6 mb-8">
        {tiers.map((plan) => {
          // Computed once per card instead of re-branching on plan.highlight
          // at every single className — six identical ternary pairs used to
          // be spelled out inline, each one counted separately toward this
          // map callback's cognitive complexity.
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
                href={ctaHref}
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
    </div>
  );
}