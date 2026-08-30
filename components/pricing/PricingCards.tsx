// ============================================================================
// The pricing tier grid — five cards, one per PricingTier — plus the live
// calculator that sits above it. Extracted out of components/pricing/
// PricingSection.tsx so both can be shared by pages that want them but have
// their own header/copy/toggle around them.
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
// The calculator answers the question the cards can't: "from $X" is honest
// about the floor but never tells a visitor their own number. It computes
// from lib/stripe/brackets.ts directly — the same module the cards' own
// numbers come from via plan-tiers.ts — so it can never show a total the
// real Stripe price would disagree with. Its answer also highlights the
// matching card below via TIER_UPPER_BOUNDS, so the two don't read as two
// unrelated pricing UIs bolted together.
//
// app/hosts/page.tsx is NOT a consumer here on purpose: its 2-card layout
// (bigger cards, a solid-fill highlight on the ENTRY tier rather than
// Growth, no "Most Popular" ribbon) is a deliberately different comparison
// for a narrower funnel — not a copy of this grid that drifted, the way
// homepage-content.tsx's was. Folding it in would mean adding a variant
// prop to preserve a genuinely different design, not removing duplication.
// ============================================================================

"use client";

import { useState } from "react";
import Link from "next/link";
import { monthlyCostCents, annualCostCents, bracketBreakdown, MAX_SELF_SERVE_PROPERTIES } from "@/lib/stripe/brackets";
import { TIER_UPPER_BOUNDS, type PricingTier } from "./plan-tiers";

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

const DEFAULT_QTY = 20; // Falls inside Growth — the tier already marked "Most Popular".

/** Which of the four priced tiers (Hosts/Starter/Growth/Portfolio) covers `qty`. Enterprise (index 4) if none do. */
function tierIndexForQty(qty: number): number {
  const idx = TIER_UPPER_BOUNDS.findIndex((bound) => qty <= bound);
  return idx === -1 ? TIER_UPPER_BOUNDS.length : idx;
}

function PricingCalculator({
  qty, onQtyChange, annual, matchedTierName,
}: Readonly<{ qty: number; onQtyChange: (n: number) => void; annual: boolean; matchedTierName: string }>) {
  const monthly = monthlyCostCents(qty)! / 100;
  const shown   = (annual ? annualCostCents(qty)! : monthlyCostCents(qty)!) / 100;
  const items   = bracketBreakdown(qty, annual ? "annual" : "monthly");

  return (
    <div className="rounded-2xl border border-[var(--mkt-border)] bg-white p-6 mb-6">
      <div className="flex flex-col md:flex-row md:items-center gap-6">
        <div className="flex-1">
          <label htmlFor="pricing-calc-qty" className="text-xs font-semibold text-[var(--mkt-muted)] uppercase tracking-wide">
            How many properties do you manage?
          </label>
          <div className="flex items-center gap-4 mt-2">
            <input
              type="range"
              min={1}
              max={MAX_SELF_SERVE_PROPERTIES}
              value={qty}
              onChange={(e) => onQtyChange(Number(e.target.value))}
              className="flex-1 accent-[var(--mkt-gold)]"
              aria-label="Number of properties"
            />
            <input
              id="pricing-calc-qty"
              type="number"
              min={1}
              max={MAX_SELF_SERVE_PROPERTIES}
              value={qty}
              onChange={(e) => onQtyChange(Math.min(MAX_SELF_SERVE_PROPERTIES, Math.max(1, Number(e.target.value) || 1)))}
              className="w-16 text-center font-mono font-semibold rounded-lg border border-[var(--mkt-border)] py-1.5 text-[var(--mkt-ink)]"
            />
          </div>
        </div>

        <div className="flex-1 text-center md:text-right">
          <div className="text-xs font-semibold text-[var(--mkt-muted)] uppercase tracking-wide mb-1">
            Your price
          </div>
          <div className="font-mono font-black text-[var(--mkt-ink)] leading-none" style={{ fontSize: 40, letterSpacing: '-0.02em' }}>
            ${shown.toLocaleString()}
            <span className="text-sm font-semibold text-[var(--mkt-muted)] ml-1">{annual ? '/yr' : '/mo'}</span>
          </div>
          <p className="text-xs text-[var(--mkt-muted)] mt-1">
            Highlighted below: the <span className="font-semibold text-[var(--mkt-ink)]">{matchedTierName}</span> plan
          </p>
        </div>
      </div>

      <details className="mt-4 border-t border-dashed border-[var(--mkt-border)] pt-3">
        <summary className="cursor-pointer text-xs font-bold text-[var(--mkt-gold-hover)] select-none">
          See the math
        </summary>
        <div className="mt-2 rounded-lg bg-[var(--mkt-surface)] p-3 text-xs font-mono space-y-1">
          {items.map((item) => (
            <div key={item.label} className="flex justify-between text-[var(--mkt-muted)]">
              <span>{item.label}</span>
              <span className="text-[var(--mkt-ink)] font-semibold">${(item.lineTotalCents / 100).toLocaleString()}</span>
            </div>
          ))}
          <div className="flex justify-between pt-2 mt-1 border-t border-[var(--mkt-border)] font-bold text-[var(--mkt-ink)]">
            <span>Total</span>
            <span>${monthly.toLocaleString()}/mo</span>
          </div>
        </div>
      </details>
    </div>
  );
}

export default function PricingCards({ tiers, annual, signupHref }: Readonly<PricingCardsProps>) {
  const [qty, setQty] = useState(DEFAULT_QTY);
  const activeIndex = tierIndexForQty(qty);

  return (
    <div>
      <PricingCalculator
        qty={qty}
        onQtyChange={setQty}
        annual={annual}
        matchedTierName={tiers[activeIndex]?.name ?? tiers[0]!.name}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-6">
        {tiers.map((plan, i) => {
          // Computed once per card instead of re-branching on plan.highlight at
          // every single className — six identical ternary pairs used to be
          // spelled out inline, each one counted separately toward this map
          // callback's cognitive complexity.
          const isMatch      = i === activeIndex
          const cardClass    = plan.highlight ? "bg-brand-800 border-[var(--mkt-gold)]" : "bg-[var(--mkt-surface)] border-[var(--mkt-border)]"
          const primaryText  = plan.highlight ? "text-white" : "text-[var(--mkt-ink)]"
          const mutedText    = plan.highlight ? "text-[var(--mkt-on-dark-soft)]" : "text-[var(--mkt-muted)]"
          const featureText  = plan.highlight ? "text-[var(--mkt-on-dark-softer)]" : "text-[var(--mkt-muted)]"
          const propsBadge   = plan.highlight ? "bg-brand-panel text-[var(--mkt-on-dark-softer)]" : "bg-white border border-[var(--mkt-border)] text-[var(--mkt-ink)]"
          const ctaClass     = plan.highlight ? "bg-[var(--mkt-gold)] text-[var(--mkt-ink)] hover:bg-[var(--mkt-gold-hover)]" : "bg-brand-800 text-white hover:bg-[var(--mkt-ink-hover)]"

          return (
          <div
            key={plan.name}
            className={`rounded-2xl p-6 border relative flex flex-col ${cardClass} ${isMatch ? 'ring-2 ring-[var(--mkt-gold)]' : ''}`}
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
    </div>
  );
}
