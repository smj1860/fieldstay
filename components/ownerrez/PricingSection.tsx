"use client";

import { useState } from "react";
import Link from "next/link";

interface PricingSectionProps {
  isLoggedIn: boolean;
}

const PLANS = [
  {
    name: "Pro",
    description: "For independent managers with a focused portfolio.",
    monthly: 149,
    annual: 1490,
    annualSavings: 298,
    properties: "Up to 15 properties",
    features: [
      "iCal sync (Airbnb, VRBO)",
      "Turnover board + crew app",
      "Offline checklist + photo capture",
      "Inventory with auto purchase orders",
      "Maintenance + vendor portal",
      "Owner P&L portal",
      "Crew email invites",
    ],
    highlight: false,
  },
  {
    name: "Growth",
    description: "For growing operations that need more scale.",
    monthly: 219,
    annual: 2190,
    annualSavings: 438,
    properties: "16–45 properties",
    features: [
      "Everything in Pro",
      "Up to 45 properties",
      "Priority support",
    ],
    highlight: true,
  },
  {
    name: "Enterprise",
    description: "For professional managers running a full operation.",
    monthly: null,
    annual: null,
    annualSavings: null,
    properties: "45+ properties",
    features: [
      "Everything in Growth",
      "Unlimited properties",
      "Custom onboarding",
      "Dedicated account support",
    ],
    highlight: false,
  },
];

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
          Full software on every plan. 14-day free trial. No credit card required.
        </p>

        {/* Toggle */}
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
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

            <div className="mb-5">
              <div className={`font-bold text-lg mb-1 ${plan.highlight ? "text-white" : "text-[#0a1628]"}`}>
                {plan.name}
              </div>

              <div className="flex items-end gap-1 mb-1 min-h-[48px]">
                {plan.monthly !== null ? (
                  <>
                    <span className={`text-3xl font-bold ${plan.highlight ? "text-white" : "text-[#0a1628]"}`}>
                      ${annual ? Math.round(plan.annual! / 12) : plan.monthly}
                    </span>
                    <span className={`mb-1 text-sm ${plan.highlight ? "text-[#8a9bb0]" : "text-[#5a6a7a]"}`}>
                      /mo
                    </span>
                    {annual && (
                      <span className="text-xs text-[#4ade80] mb-1 ml-1">
                        billed ${plan.annual!.toLocaleString()}/yr
                      </span>
                    )}
                  </>
                ) : (
                  <span className={`text-3xl font-bold ${plan.highlight ? "text-[#FCD116]" : "text-[#FCD116]"}`}>
                    Custom
                  </span>
                )}
              </div>

              {annual && plan.annualSavings && (
                <div className="text-xs text-[#4ade80] mb-2">
                  Save ${plan.annualSavings.toLocaleString()}/yr
                </div>
              )}

              <p className={`text-sm ${plan.highlight ? "text-[#8a9bb0]" : "text-[#5a6a7a]"}`}>
                {plan.description}
              </p>
              <div className={`text-xs font-semibold mt-2 rounded-lg px-3 py-1.5 inline-block ${
                plan.highlight
                  ? "bg-[#0c1e3a] text-[#a0b4cc]"
                  : "bg-white border border-[#e2e8f0] text-[#0a1628]"
              }`}>
                {plan.properties}
              </div>
            </div>

            <ul className="space-y-2.5 mb-6 flex-1">
              {plan.features.map((f) => (
                <li key={f} className={`flex items-center gap-2 text-sm ${
                  plan.highlight ? "text-[#a0b4cc]" : "text-[#5a6a7a]"
                }`}>
                  <svg width="12" height="10" viewBox="0 0 12 10" fill="none" className="flex-shrink-0">
                    <path d="M1 5l4 4 6-8" stroke="#FCD116" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>

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

      {/* RepuGuard note */}
      <p className="text-center text-sm text-[#8a9bb0]">
        All plans include a{" "}
        <span className="text-[#0a1628] font-semibold">3-month RepuGuard trial</span>
        {" "}— exclusively for OwnerRez users. Then{" "}
        <span className="text-[#0a1628] font-medium">$15/mo for life</span> if activated
        before Jan 1{" "}
        <span className="line-through text-[#c0cad5]">$29/mo</span>.
      </p>
    </div>
  );
}
