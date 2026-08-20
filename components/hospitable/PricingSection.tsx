"use client";

import SharedPricingSection from "@/components/pricing/PricingSection";

// See components/ownerrez/PricingSection.tsx — same shape. These two files
// used to be 274 and 281 lines that differed only in this list and the
// provider slug, which is exactly the duplication SonarCloud flagged when the
// Hosts tier was added to both.
const ENTRY_FEATURES = [
  "Hospitable sync (properties, bookings, teammates)",
  "Turnover board + crew app",
  "Offline checklist + photo capture",
  "Inventory with auto purchase orders",
  "Maintenance + no-login vendor portal",
  "Asset health scores + CapEx forecasting",
  "Owner P&L portal",
  "RepuGuard reputation management",
] as const;

export default function PricingSection() {
  return (
    <SharedPricingSection
      provider="hospitable"
      entryFeatures={ENTRY_FEATURES}
    />
  );
}
