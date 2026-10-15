// ============================================================================
// Every FieldStay claim on this page cites the file that implements it (the
// text is shared with /breezeway-alternative via components/marketing/
// fieldstay-claims.ts, which that page's test keeps honest).
//
// Every Operto Teams claim cites the public source it came from and the date it was
// checked. Operto Teams is a live competitor's product, so its pricing and features can
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

export const COMPETITOR_PRICING_URL = 'https://operto.com/pricing'

export const COMPETITOR_PRICE_CARD = {
  headline: 'Demo first',
  body:
    'No price for Operto Teams is published on operto.com/teams or operto.com/pricing; both point to a demo ' +
    'request (checked 2026-10-14). A free trial was not mentioned. Pricing at ' +
    'any property count therefore starts with a conversation.',
} as const

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  comparisonRow(
    'Pricing model',
    fieldstayClaim('Pricing model'),
    'No price is published for Operto Teams. The Teams and pricing pages direct visitors to a free ' +
      'personalized demo, and no unit, tiers or free trial are stated.',
    'operto.com/teams and operto.com/pricing, checked 2026-10-14',
  ),
  comparisonRow(
    'Vendor work orders',
    fieldstayClaim('Vendor work orders'),
    'Operto Teams describes multi-language staff dashboards. A third-party integration listing adds time ' +
      'tracking, issue submission, accepting or declining tasks and image upload. Whether staff need an ' +
      'account or a native app was not independently confirmed.',
    'operto.com/teams and hostfully.com/integrations/operto-teams (third-party), checked 2026-10-14',
  ),
  comparisonRow(
    'Offline support',
    FIELDSTAY_OFFLINE,
    'Offline use is not stated on the Operto pages reviewed, so no comparison is made.',
    'operto.com/teams, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'Asset planning & CapEx forecasting',
    fieldstayClaim('Asset planning & CapEx forecasting'),
    'Operto Teams lists Maintenance Tracking and says it automates housekeeping, inventory and maintenance. ' +
      'Work orders, an asset ledger and capital forecasting were not described on the pages reviewed, so no ' +
      'comparison is made.',
    'operto.com/teams, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'Guest guidebook',
    fieldstayClaim('Guest guidebook'),
    'Operto\'s page describes a branded guidebook as part of Operto Guest, a separate product. Whether it ' +
      'is bundled with Operto Teams was not independently confirmed.',
    'operto.com/teams, checked 2026-10-14',
  ),
  comparisonRow(
    'Bookkeeper and finance access',
    fieldstayClaim('Bookkeeper and finance access'),
    'Payroll reports and staff time tracking are listed by a third-party integration page. Roles and ' +
      'permissions, including any finance-only role, were not independently confirmed.',
    'hostfully.com/integrations/operto-teams (third-party), checked 2026-10-14, roles not confirmed either way',
  ),
  comparisonRow(
    'PMS integrations',
    FIELDSTAY_PMS,
    'Operto says Teams connects with leading property management software and over 150 third-party ' +
      'solutions, and the page names RMS and Lodgify. The full list was not independently confirmed.',
    'operto.com/teams, checked 2026-10-14',
  ),
]
