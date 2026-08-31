import { CREW_VISIBILITY_FAQ, TEAM_ACCESS_FAQ, MARKETING_OFFLINE_FAQ, MARKETING_TRIAL_FAQ } from '@/lib/faq-content'

// ============================================================================
// Structured data for /hospitable. Same pattern as app/strops/json-ld.ts and
// app/breezeway-alternative/json-ld.ts (FAQPage + SoftwareApplication) —
// serializeJsonLd is imported from strops rather than reimplemented.
//
// MARKETING_FAQ lives HERE, not in components/hospitable/faq-section.tsx
// (which re-exports it) — see app/ownerrez/json-ld.ts's header comment for
// why: that component has 'use client' at the top, and a plain data array
// exported from a 'use client' module is not safe to import into server
// code — it throws "MARKETING_FAQ.map is not a function" during `next
// build`'s static generation pass, even though it works fine in dev.
//
// See app/ownerrez/json-ld.ts's header comment for why the
// SoftwareApplication @id is the same shared literal on every page, not a
// per-page value — deliberate, not a bug.
// ============================================================================

export const HOSPITABLE_PATH = '/hospitable'

export const MARKETING_FAQ = [
  {
    q: 'Does FieldStay replace Hospitable?',
    a: 'No — FieldStay is a field operations layer that works alongside Hospitable. Hospitable handles bookings, rates, and guest messaging. FieldStay handles what happens on the ground: turnovers, crew assignments, inventory, maintenance, capital planning, and owner reporting. Your Hospitable account stays your system of record — FieldStay never writes back to it.',
  },
  {
    q: 'How long does setup take?',
    a: 'Connecting Hospitable takes about 2 minutes via OAuth. Your properties and upcoming bookings appear within a minute or two. If you have teammates set up in Hospitable, they sync in automatically too — name, email, phone, and role, mapped straight into FieldStay crew accounts.',
  },
  {
    q: 'What data syncs from Hospitable?',
    a: 'FieldStay syncs your properties, upcoming bookings, and teammates on initial connection, then stays current in real time via webhooks — new and modified reservations, cancellations, property changes, and new reviews (which trigger a RepuGuard draft response automatically). It\'s read-only: nothing FieldStay does ever changes your Hospitable data.',
  },
  {
    q: 'How do my crew members access the app?',
    a: 'Teammates synced from Hospitable are added as FieldStay crew members automatically, mapped to the right role — Cleaning, Maintenance, Concierge, Manager, and so on. They get an email invite, create a free account, and install the app to their phone home screen. No App Store required, and they only ever see their own assigned turnovers.',
  },
  {
    // Shared verbatim with the OwnerRez landing page — see lib/faq-content.ts.
    q: MARKETING_OFFLINE_FAQ.question,
    a: MARKETING_OFFLINE_FAQ.answer,
  },
  {
    q: MARKETING_TRIAL_FAQ.question,
    a: MARKETING_TRIAL_FAQ.answer,
  },
  {
    // Shared verbatim with the other landing page and the in-app help page —
    // see lib/faq-content.ts for the claim-by-claim RLS backing.
    q: CREW_VISIBILITY_FAQ.question,
    a: CREW_VISIBILITY_FAQ.answer,
  },
  {
    q: TEAM_ACCESS_FAQ.question,
    a: TEAM_ACCESS_FAQ.answer,
  },
] as const

export function buildJsonLd(marketingUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${marketingUrl}${HOSPITABLE_PATH}#faq`,
        mainEntity: MARKETING_FAQ.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${marketingUrl}#software`,
        name: 'FieldStay',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, iOS, Android',
        description:
          'Field operations layer for Hospitable property managers: automated turnovers, crew sync, asset ' +
          'health tracking, capital planning, and a no-login vendor portal.',
        featureList: [
          'No-login vendor work order portal with invoicing',
          'Asset health scoring and CapEx forecasting',
          'Automated turnover scheduling from Hospitable bookings',
          'Teammates sync in automatically as FieldStay crew',
          'Inventory par levels and restocking',
          'Owner P&L reporting',
          'RepuGuard AI review response drafting',
        ],
        // Same rule as strops/breezeway-alternative: this price must also be
        // visible on the rendered page, not just in the schema.
        offers: {
          '@type': 'Offer',
          price: '49',
          priceCurrency: 'USD',
          description: 'Starting at $49/month for your first property. 14-day free trial, no credit card required.',
        },
      },
    ],
  }
}

export { serializeJsonLd } from '@/app/strops/json-ld'
