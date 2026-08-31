import { MARKETING_OFFLINE_FAQ, MARKETING_TRIAL_FAQ, CREW_VISIBILITY_FAQ, TEAM_ACCESS_FAQ } from '@/lib/faq-content'

// ============================================================================
// Structured data for the homepage. Same pattern as app/strops/json-ld.ts and
// app/breezeway-alternative/json-ld.ts (FAQPage + SoftwareApplication) —
// serializeJsonLd is imported from strops rather than reimplemented.
//
// HOMEPAGE_FAQ_ITEMS lives HERE, not in components/landing/homepage-content.tsx
// (which re-exports it) — see app/ownerrez/json-ld.ts's header comment for
// why: that component has 'use client' at the top, and a plain data array
// exported from a 'use client' module is not safe to import into server
// code — it throws "<name>.map is not a function" during `next build`'s
// static generation pass, even though it works fine in dev.
//
// The featureList/description here are the BROADEST of every landing page's
// json-ld.ts — this is the site's general entity, not a segment- or
// integration-specific one, so it names the site's core value props rather
// than leading with any one of them the way /strops (offline) or /ownerrez
// (OwnerRez-specific) do.
//
// See app/ownerrez/json-ld.ts's header comment for why the
// SoftwareApplication @id is the same shared literal on every page.
// ============================================================================

export const HOMEPAGE_PATH = '/'

export const HOMEPAGE_FAQ_ITEMS = [
  { q: MARKETING_OFFLINE_FAQ.question, a: MARKETING_OFFLINE_FAQ.answer },
  { q: MARKETING_TRIAL_FAQ.question, a: MARKETING_TRIAL_FAQ.answer },
  { q: CREW_VISIBILITY_FAQ.question, a: CREW_VISIBILITY_FAQ.answer },
  { q: TEAM_ACCESS_FAQ.question, a: TEAM_ACCESS_FAQ.answer },
] as const

export function buildJsonLd(marketingUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${marketingUrl}${HOMEPAGE_PATH}#faq`,
        mainEntity: HOMEPAGE_FAQ_ITEMS.map((f) => ({
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
          'Property operations platform for short-term rental managers: automated turnovers, an offline-' +
          'first crew app, a no-login vendor portal, asset health and CapEx forecasting, and a self-funding ' +
          'guest guidebook.',
        featureList: [
          'Automated turnover scheduling from PMS bookings',
          'Offline-first crew app with photo capture',
          'No-login vendor work order portal with invoicing',
          'Asset health scoring and CapEx forecasting',
          'Inventory par levels with automatic restocking',
          'Owner P&L reporting portal',
          'Self-funding guest guidebook with local business sponsors',
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
