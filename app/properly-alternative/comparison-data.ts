// ============================================================================
// Every FieldStay claim on this page cites the file that implements it (the
// text is shared with /breezeway-alternative via components/marketing/
// fieldstay-claims.ts, which that page's test keeps honest).
//
// Every Properly claim cites the public source it came from and the date it was
// checked. Properly is a live competitor's product, so its pricing and features can
// change under us at any time. Nothing here is inferred. A claim that cannot
// be cited is not written; "not independently confirmed, so no comparison is
// made" is a valid cell. A competitor is never described as LACKING a feature.
// unit/guardrails/comparison-page-claims.test.ts enforces the dates.
// ============================================================================

import { comparisonRow, fieldstayClaim, FIELDSTAY_OFFLINE, FIELDSTAY_PMS } from '@/components/marketing/fieldstay-claims'
import type { ComparisonRow } from '@/app/breezeway-alternative/comparison-data'

/**
 * The OLDEST check date across every competitor claim below, not the newest.
 * The page renders it as "checked on or after", and each row carries its own
 * date inside its source. Bumping this to the newest date would assert a sweep
 * that did not happen. Move it only when every row's own date has moved.
 */
export const RESEARCHED_ON = '2026-10-14'

export const COMPETITOR_PRICING_URL = 'https://getproperly.com/pricing'

export const COMPETITOR_PRICE_CARD = {
  headline: 'From $12.99/property',
  body:
    'Properly lists self-service Platform from $12.99 per property per month, Pro from $14.99 with direct ' +
    'PMS sync, and custom pricing for larger portfolios (checked 2026-10-14). The exact figure at ' +
    '10 properties depends on the tier and any volume discount, so check their pricing page for your count.',
} as const

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  comparisonRow(
    'Pricing model',
    fieldstayClaim('Pricing model'),
    'Per-property tiers. Self-service Platform from $12.99 per property per month, Pro from $14.99 with ' +
      'direct PMS API sync, volume tiers that fall lower, and "talk to us about custom pricing" for ' +
      'portfolios. Real-Time Inspection is $5 per inspection. The Platform has a 30-day free trial.',
    'getproperly.com/pricing, checked 2026-10-14',
  ),
  comparisonRow(
    'Vendor work orders',
    fieldstayClaim('Vendor work orders'),
    'Cleaners must be invited by a host or property manager, sign up for a Properly account and use the ' +
      'free Properly app. Dispatch of non-cleaning vendors as work orders was not independently confirmed.',
    'help.getproperly.com/en/articles/5386300-step-1-create-a-properly-account and getproperly.com/features/marketplace, checked 2026-10-14',
  ),
  comparisonRow(
    'Offline support',
    FIELDSTAY_OFFLINE,
    'Properly\'s platform page says cleaners get a dedicated app with offline support and push ' +
      'notifications. What works offline and how it syncs was not independently confirmed.',
    'getproperly.com/platform, checked 2026-10-14',
  ),
  comparisonRow(
    'Asset planning & CapEx forecasting',
    fieldstayClaim('Asset planning & CapEx forecasting'),
    'Properly lists issue reporting and maintenance management. An asset ledger, health scoring and capital ' +
      'forecasting were not independently confirmed, so no comparison is made.',
    'getproperly.com/properly-vs-breezeway, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'Guest guidebook',
    fieldstayClaim('Guest guidebook'),
    'A digital guidebook was not found on the Properly platform or features pages. Properly lists AI-assisted ' +
      'guest support as a service.',
    'getproperly.com/platform and getproperly.com/features, checked 2026-10-14, guidebook not confirmed either way',
  ),
  comparisonRow(
    'Bookkeeper and finance access',
    fieldstayClaim('Bookkeeper and finance access'),
    'Properly\'s roles and permissions, including any finance-only role, were not independently confirmed ' +
      'on the pages reviewed, so no comparison is made.',
    'getproperly.com/platform, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'PMS integrations',
    FIELDSTAY_PMS,
    'Properly names BookingSync, Escapia, Guesty, Hostaway, Hostfully, Hospitable, Smoobu, Streamline and ' +
      'others, and syncs Airbnb and 50 or more other platforms by iCal. Direct API integration is listed on ' +
      'the Pro plan.',
    'getproperly.com, checked 2026-10-14',
  ),
]
