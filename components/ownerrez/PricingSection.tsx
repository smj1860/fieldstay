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
      "RepuGuard reputation management",
    ],
  },
  {
    name: "Growth",
    description: "For expanding operations that need more scale.",
    monthly: 479,
    annual: 4790,        // 2 months free: $479 × 10
    annualSavings: 958,  // $479 × 2
    properties: "16–50 properties",
    highlight: true,
    features: [
      "Everything in Starter",
      "Up to 50 properties",
      "Priority support",
    ],
  },
  {
    name: "Portfolio",
    description: "For professional managers running a full operation.",
    monthly: 799,
    annual: 7990,         // 2 months free: $799 × 10
    annualSavings: 1598,  // $799 × 2
    properties: "51–100 properties",
    highlight: false,
    features: [
      "Everything in Growth",
      "Up to 100 properties",
      "Custom onboarding",
      "Dedicated account support",
    ],
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
  },
];

export default function PricingSection({ isLoggedIn }: Readonly<PricingSectionProps>) {
  const [annual, setAnnual] = useState(false);

  const ctaHref = isLoggedIn
    ? "/api/integrations/ownerrez/connect"
    : "/signup?provider=ownerrez&next=/api/integrations/ownerrez/connect";

  return (
    <div>
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold mb-3 text-[#0a1628] font-display">
          We do business differently.
        </h2>
        <p className="text-gray-500 mb-2">
          Simple, transparent pricing. 14-day free trial, no credit card required.
        </p>
        <p className="text-gray-600 text-sm mx-auto mb-6" style={{ maxWidth: 480 }}>
          Most STR software makes you pay per property and gates parts of
          the software behind higher tiers. It doesn&apos;t have to be that
          way. Flat tier pricing. All the features, no gates.
        </p>

        {/* Monthly / Annual toggle */}
        <div className="inline-flex items-center gap-1 bg-[#f1f5f9] border border-[#e2e8f0] rounded-full p-1">
          <button
            onClick={() => setAnnual(false)}
            aria-pressed={!annual}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all ${
              !annual
                ? "bg-brand-800 text-white shadow-sm"
                : "text-gray-500 hover:text-[#0a1628]"
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
                : "text-gray-500 hover:text-[#0a1628]"
            }`}
          >
            Annual
            <span className="text-xs bg-gold-300 text-[#0a1628] px-2 py-0.5 rounded-full font-bold">
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
                ? "bg-brand-800 border-gold-300"
                : "bg-[#f8fafc] border-[#e2e8f0]"
            }`}
          >
            {plan.highlight && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gold-300 text-[#0a1628] text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap">
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
                      ${annual ? plan.annual!.toLocaleString() : plan.monthly}
                    </span>
                    <span
                      className={`mb-1 text-sm ${
                        plan.highlight ? "text-white/52" : "text-gray-500"
                      }`}
                    >
                      {annual ? '/yr' : '/mo'}
                    </span>
                  </>
                ) : (
                  <span className="text-3xl font-bold text-gold-300">
                    Custom
                  </span>
                )}
              </div>

              <p
                className={`text-sm ${
                  plan.highlight ? "text-white/52" : "text-gray-500"
                }`}
              >
                {plan.description}
              </p>

              <div
                className={`text-xs font-semibold mt-2 rounded-lg px-3 py-1.5 inline-block ${
                  plan.highlight
                    ? "bg-brand-panel text-white/58"
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
                    plan.highlight ? "text-white/58" : "text-gray-500"
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
            </ul>

            {/* CTA */}
            {plan.monthly !== null ? (
              <Link
                href={ctaHref}
                className={`block text-center py-3 rounded-xl text-sm font-bold transition-colors ${
                  plan.highlight
                    ? "bg-gold-300 text-[#0a1628] hover:bg-[#EAB800]"
                    : "bg-brand-800 text-white hover:bg-[#162a4a]"
                }`}
              >
                Start Free Trial
              </Link>
            ) : (
              <a
                href="mailto:hello@fieldstay.app"
                className="block text-center py-3 rounded-xl text-sm font-bold transition-colors bg-brand-800 text-white hover:bg-[#162a4a]"
              >
                Contact Us
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}