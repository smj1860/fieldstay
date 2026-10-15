// ============================================================================
// Every FieldStay claim on this page cites the file that implements it (the
// text is shared with /breezeway-alternative via components/marketing/
// fieldstay-claims.ts, which that page's test keeps honest).
//
// Every Turno claim cites the public source it came from and the date it was
// checked. Turno is a live competitor's product, so its pricing and features can
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

export const COMPETITOR_PRICING_URL = 'https://turno.com/pricing/'

export const COMPETITOR_PRICE_CARD = {
  headline: 'Per property',
  body:
    'Turno publishes a per-property subscription: no charge for a host with one property or for a host who ' +
    'uses only Turno Marketplace cleaners, and about $10 per property per month ($96 per property per year) ' +
    'for a host who brings their own teammates to more than one property (checked 2026-10-14). A price for ' +
    'larger portfolios was not independently confirmed, so verify the figure for your own count on their site.',
} as const

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  comparisonRow(
    'Pricing model',
    fieldstayClaim('Pricing model'),
    'A per-property subscription. Turno\'s pricing and help pages describe no charge for one property or for ' +
      'marketplace-only hosts, and about $10 per property per month ($96 per year) for hosts with their own ' +
      'teammates on more than one property. Billing is by property, not by cleaner. Whether a quote or demo ' +
      'is required at larger sizes was not independently confirmed.',
    'turno.com/pricing, help.turno.com/en/articles/5607345-how-do-paid-subscriptions-work-for-hosts-on-turno and the Capterra listing for the annual figure, checked 2026-10-14',
  ),
  comparisonRow(
    'Vendor work orders',
    fieldstayClaim('Vendor work orders'),
    'Cleaners use a free Turno app and are invited to properties as teammates. Whether an invited cleaner ' +
      'must create an account and use the app was not independently confirmed, and neither was dispatch of ' +
      'non-cleaning contractors as work orders.',
    'turno.com/for-cleaner and help.turno.com/en/articles/2801637-inviting-and-connecting-with-teammates-or-co-hosts, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'Offline support',
    FIELDSTAY_OFFLINE,
    'Offline use is not stated on the Turno pages reviewed, so no comparison is made.',
    'turno.com/features/photo-checklists and the Turno Hosts App Store listing, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'Asset planning & CapEx forecasting',
    fieldstayClaim('Asset planning & CapEx forecasting'),
    'Turno\'s materials describe cleaners flagging problems as exceptions that notify the host. An asset ' +
      'ledger, health scoring or capital forecast was not independently confirmed, so no comparison is made.',
    'turno.com/blog/short-term-rental-maintenance-guide, checked 2026-10-14, not confirmed either way',
  ),
  comparisonRow(
    'Guest guidebook',
    fieldstayClaim('Guest guidebook'),
    'A digital guidebook was not found on the Turno pages reviewed. Turno does list a Check-in/Welcoming ' +
      'project type, where a teammate meets the guest at arrival.',
    'help.turno.com/en/articles/9118514-how-to-use-check-in-welcoming-projects, checked 2026-10-14, guidebook not confirmed either way',
  ),
  comparisonRow(
    'Bookkeeper and finance access',
    fieldstayClaim('Bookkeeper and finance access'),
    'Co-hosts hold one of two roles, Co-host or Administrator, with the host choosing which properties and ' +
      'which areas (checklists, inventory, teammates, payment methods, reports) each co-host can edit. A ' +
      'finance-only role was not independently confirmed.',
    'help.turno.com/en/articles/6337717-how-to-use-co-host-permissions, checked 2026-10-14',
  ),
  comparisonRow(
    'PMS integrations',
    FIELDSTAY_PMS,
    'Turno\'s integrations page lists Guesty, Hostaway, Hospitable, Lodgify and OwnerRez, and calendars can ' +
      'also sync by iCal from Airbnb, VRBO, Booking.com and others. The complete current list was not ' +
      'independently confirmed.',
    'turno.com/integrations and help.turno.com/en/articles/2795682-syncing-a-rental-calendar-via-ical, checked 2026-10-14',
  ),
]
