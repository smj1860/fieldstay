// ============================================================================
// Every FieldStay claim on this page cites the file that implements it (the
// text is shared with /breezeway-alternative via components/marketing/
// fieldstay-claims.ts, which that page's test keeps honest).
//
// Every EZCare claim cites the public source it came from and the date it was
// checked. EZCare is a live competitor's product, so its pricing and features can
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

export const COMPETITOR_PRICING_URL = 'https://www.ezcare.io'

export const COMPETITOR_PRICE_CARD = {
  headline: 'Demo request',
  body:
    'No price was found on the EZcare pages reviewed; the call to action is a demo request (checked ' +
    '2026-10-14). Pricing at any property count therefore starts with a conversation.',
} as const

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  comparisonRow(
    'Pricing model',
    fieldstayClaim('Pricing model'),
    'No price was found on the EZcare pages reviewed. The home and housekeeping pages link to a demo ' +
      'request, and no unit, tiers or free trial are stated.',
    'ezcare.io and ezcare.io/vacation-rental-housekeeping-software, checked 2026-10-14',
  ),
  comparisonRow(
    'Vendor work orders',
    fieldstayClaim('Vendor work orders'),
    'EZcare describes a mobile app for staff and says to "invite your whole team". Whether a staff member ' +
      'or vendor needs an account and the native app was not independently confirmed.',
    'ezcare.io/vacation-rental-housekeeping-software, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'Offline support',
    FIELDSTAY_OFFLINE,
    'Offline use is not stated on the EZcare pages reviewed, so no comparison is made.',
    'ezcare.io/vacation-rental-housekeeping-software and ezcare.io/vacation-rental-maintenance-software, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'Asset planning & CapEx forecasting',
    fieldstayClaim('Asset planning & CapEx forecasting'),
    'EZcare\'s maintenance page says work order creation is automated and technicians are alerted, and ' +
      'describes a per-property record of make, model, installation date and warranty for appliances. Health ' +
      'scoring and capital forecasting were not independently confirmed.',
    'ezcare.io/vacation-rental-maintenance-software, checked 2026-10-14',
  ),
  comparisonRow(
    'Guest guidebook',
    fieldstayClaim('Guest guidebook'),
    'A guest guidebook was not found on the EZcare pages reviewed. The housekeeping page lists staff and ' +
      'guest communication as a solution.',
    'ezcare.io/vacation-rental-housekeeping-software, checked 2026-10-14, guidebook not confirmed either way',
  ),
  comparisonRow(
    'Bookkeeper and finance access',
    fieldstayClaim('Bookkeeper and finance access'),
    'EZcare\'s roles and permissions, including any finance-only role, were not independently confirmed on ' +
      'the pages reviewed, so no comparison is made.',
    'ezcare.io, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'PMS integrations',
    FIELDSTAY_PMS,
    'EZcare\'s integrations page claims two-way integration with a long list of partners, including ' +
      'Streamline, Track, Escapia, Guesty, Hostfully, OwnerRez, Hostaway and Hospitable.',
    'ezcare.io/vacation-rental-integration-software, checked 2026-10-14',
  ),
]
