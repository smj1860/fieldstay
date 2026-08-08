"use client";

import SharedPricingSection from "@/components/pricing/PricingSection";

// The only thing this page's pricing table does not share with the Hospitable
// one: the entry tier's feature bullets, whose first line names the PMS being
// sold against. Everything else — prices, property ranges, the four tiers
// above Hosts, and the entire layout — lives in components/pricing/.
const ENTRY_FEATURES = [
  "iCal sync (Airbnb, VRBO)",
  "Turnover board + crew app",
  "Offline checklist + photo capture",
  "Inventory with auto purchase orders",
  "Maintenance + vendor portal",
  "Owner P&L portal",
  "Crew email invites",
  "RepuGuard reputation management",
] as const;

export default function PricingSection({ isLoggedIn }: Readonly<{ isLoggedIn: boolean }>) {
  return (
    <SharedPricingSection
      isLoggedIn={isLoggedIn}
      provider="ownerrez"
      entryFeatures={ENTRY_FEATURES}
    />
  );
}
