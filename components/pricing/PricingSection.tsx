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
//
// The card grid itself now lives in ./PricingCards.tsx, extracted so
// components/landing/homepage-content.tsx could stop hand-rolling its own
// copy of it — see that file's header comment for why that mattered.
// ============================================================================

"use client";

import { useState } from "react";

import { pricingTiers } from "./plan-tiers";
import PricingCards from "./PricingCards";

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

      {/* Plan cards — see PricingCards.tsx for the grid/card markup itself. */}
      <div className="mb-8">
        <PricingCards tiers={tiers} annual={annual} signupHref={ctaHref} />
      </div>
    </div>
  );
}