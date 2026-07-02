// components/ownerrez/PricingSection.tsx — full replacement

"use client";

import { useState } from "react";
import Link from "next/link";

interface PricingSectionProps {
  isLoggedIn: boolean;
}

// ─── Update these when Stripe price IDs change ───────────────────────────────
// These display values must match your Stripe Price objects exactly.
// Env vars: STRIPE_PRICE_STARTER_MONTHLY, STRIPE_PRICE_STARTER_ANNUAL, etc.
// ─────────────────────────────────────────────────────────────────────────────
const PLANS = [
  {
    name: "Starter",
    description: "For independent managers with a focused portfolio.",
    monthly: 199,
    annual: 1990,       // 2 months free: $199 × 10
    annualSavings: 398, // $199 × 2
    properties: "Up to 15 properties",
    highlight: false,
    features: [
      "iCal sync (Airbnb, VRBO)",
      "Turnover board + crew app",
      "Offline checklist + photo capture",
      "Inventory with auto purchase orders",
      "Maintenance + vendor portal",
      "Owner P&L portal",
      "Crew email invites",
    ],
    repuguard: true,
  },
  {
    name: "Growth",
    description: "For expanding operations that need more scale.",
    monthly: 379,
    annual: 3790,        // 2 months free: $379 × 10
    annualSavings: 758,  // $379 × 2
    properties: "16–50 properties",
    highlight: true,
    features: [
      "Everything in Starter",
      "Up to 50 properties",
      "Priority support",
    ],
    repuguard: true,
  },
  {
    name: "Portfolio",
    description: "For professional managers running a full operation.",
    monthly: 599,
    annual: 5990,         // 2 months free: $599 × 10
    annualSavings: 1198,  // $599 × 2
    properties: "51–100 properties",
    highlight: false,
    features: [
      "Everything in Growth",
      "Up to 100 properties",
      "Custom onboarding",
      "Dedicated account support",
    ],
    repuguard: true,
  },
  {
    name: "Enterprise",
    description: "For large portfolios and multi-location operations.",
    monthly: null,
    annual: null,
    annualSavings: null,
    properties: "100+ properties",
    highlight: false,
    features: [
      "Everything in Portfolio",
      "Unlimited properties",
      "SLA-backed uptime",
      "Volume pricing",
    ],
    repuguard: true,
  },
];

// Shared RepuGuard feature row — rendered identically across all plan cards
function RepuGuardFeatureRow({ highlight }: Readonly<{ highlight: boolean }>) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {/* Swap the standard yellow checkmark for a green one to visually
          distinguish RepuGuard from core platform features */}
      <svg
        width="12"
        height="10"
        viewBox="0 0 12 10"
        fill="none"
        className="flex-shrink-0"
      >
        <path
          d="M1 5l4 4 6-8"
          stroke="#4ade80"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className={highlight ? "text-[#a0b4cc]" : "text-[#5a6a7a]"}>
        RepuGuard
      </span>
      {/* Inline exclusive badge */}
      <span className="ml-auto bg-[#FCD116] text-[#0a1628] text-[10px] font-bold px-1.5 py-0.5 rounded tracking-wide leading-none flex-shrink-0">
        OR EXCLUSIVE
      </span>
    </li>
  );
}

export default function PricingSection({ isLoggedIn }: PricingSectionProps) {
  const [annual, setAnnual] = useState(false);

  const ctaHref = isLoggedIn
    ? "/api/integrations/ownerrez/connect"
    : "/signup?provider=ownerrez&next=/api/integrations/ownerrez/connect";

  return (
    <div>
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold mb-3 text-[#0a1628] font-display">
          Simple, transparent pricing
        </h2>
        <p className="text-[#5a6a7a] mb-6">
          Full platform on every plan. 14-day free trial. No credit card required.
        </p>

        {/* Monthly / Annual toggle */}
        <div className="inline-flex items-center gap-1 bg-[#f1f5f9] border border-[#e2e8f0] rounded-full p-1">
          <button
            onClick={() => setAnnual(false)}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all ${
              !annual
                ? "bg-[#102246] text-white shadow-sm"
                : "text-[#5a6a7a] hover:text-[#0a1628]"
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all flex items-center gap-2 ${
              annual
                ? "bg-[#102246] text-white shadow-sm"
                : "text-[#5a6a7a] hover:text-[#0a1628]"
            }`}
          >
            Annual
            <span className="text-xs bg-[#FCD116] text-[#0a1628] px-2 py-0.5 rounded-full font-bold">
              Save 2 months
            </span>
          </button>
        </div>
      </div>

      {/* Plan cards — 4-column grid on wide screens, 2-col on tablet, 1-col mobile */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-8">
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            className={`rounded-2xl p-6 border relative flex flex-col ${
              plan.highlight
                ? "bg-[#102246] border-[#FCD116]"
                : "bg-[#f8fafc] border-[#e2e8f0]"
            }`}
          >
            {plan.highlight && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#FCD116] text-[#0a1628] text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap">
                Most Popular
              </div>
            )}

            {/* Plan name + price */}
            <div className="mb-5">
              <div
                className={`font-bold text-lg mb-1 ${
                  plan.highlight ? "text-white" : "text-[#0a1628]"
                }`}
              >
                {plan.name}
              </div>

              <div className="flex items-end gap-1 mb-1 min-h-[48px]">
                {plan.monthly !== null ? (
                  <>
                    <span
                      className={`text-3xl font-bold ${
                        plan.highlight ? "text-white" : "text-[#0a1628]"
                      }`}
                    >
                      ${annual ? Math.round(plan.annual! / 12) : plan.monthly}
                    </span>
                    <span
                      className={`mb-1 text-sm ${
                        plan.highlight ? "text-[#8a9bb0]" : "text-[#5a6a7a]"
                      }`}
                    >
                      /mo
                    </span>
                    {annual && (
                      <span className="text-xs text-[#4ade80] mb-1 ml-1">
                        billed ${plan.annual!.toLocaleString()}/yr
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-3xl font-bold text-[#FCD116]">
                    Custom
                  </span>
                )}
              </div>

              {annual && plan.annualSavings && (
                <div className="text-xs text-[#4ade80] mb-2">
                  Save ${plan.annualSavings.toLocaleString()}/yr
                </div>
              )}

              <p
                className={`text-sm ${
                  plan.highlight ? "text-[#8a9bb0]" : "text-[#5a6a7a]"
                }`}
              >
                {plan.description}
              </p>

              <div
                className={`text-xs font-semibold mt-2 rounded-lg px-3 py-1.5 inline-block ${
                  plan.highlight
                    ? "bg-[#0e2a52] text-[#a0b4cc]"
                    : "bg-white border border-[#e2e8f0] text-[#0a1628]"
                }`}
              >
                {plan.properties}
              </div>
            </div>

            {/* Feature list */}
            <ul className="space-y-2.5 mb-6 flex-1">
              {plan.features.map((f) => (
                <li
                  key={f}
                  className={`flex items-center gap-2 text-sm ${
                    plan.highlight ? "text-[#a0b4cc]" : "text-[#5a6a7a]"
                  }`}
                >
                  <svg
                    width="12"
                    height="10"
                    viewBox="0 0 12 10"
                    fill="none"
                    className="flex-shrink-0"
                  >
                    <path
                      d="M1 5l4 4 6-8"
                      stroke="#FCD116"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {f}
                </li>
              ))}

              {/* RepuGuard always last — visually distinct from platform features */}
              {plan.repuguard && (
                <RepuGuardFeatureRow highlight={plan.highlight} />
              )}
            </ul>

            {/* CTA */}
            {plan.monthly !== null ? (
              <Link
                href={ctaHref}
                className={`block text-center py-3 rounded-xl text-sm font-bold transition-colors ${
                  plan.highlight
                    ? "bg-[#FCD116] text-[#0a1628] hover:bg-[#EAB800]"
                    : "bg-[#102246] text-white hover:bg-[#162a4a]"
                }`}
              >
                Start Free Trial
              </Link>
            ) : (
              <a
                href="mailto:hello@fieldstay.app"
                className="block text-center py-3 rounded-xl text-sm font-bold transition-colors bg-[#102246] text-white hover:bg-[#162a4a]"
              >
                Contact Us
              </a>
            )}
          </div>
        ))}
      </div>

      {/* Footer note — bundled confirmation, zero add-on language */}
      <div className="flex items-center justify-center gap-2.5">
        <span
          className="text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ background: '#3D8B4F' }}
        >
          OR
        </span>
        <p className="text-sm text-[#8a9bb0] text-center">
          RepuGuard reputation management is{" "}
          <span className="text-[#0a1628] font-semibold">
            included in every plan
          </span>{" "}
          — an exclusive feature for OwnerRez users.
        </p>
      </div>
    </div>
  );
}