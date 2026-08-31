import { CREW_VISIBILITY_FAQ, TEAM_ACCESS_FAQ, MARKETING_OFFLINE_FAQ, MARKETING_TRIAL_FAQ } from '@/lib/faq-content'

// ============================================================================
// Structured data for /ownerrez. Same pattern as app/strops/json-ld.ts and
// app/breezeway-alternative/json-ld.ts (FAQPage + SoftwareApplication) —
// serializeJsonLd is imported from strops rather than reimplemented.
//
// MARKETING_FAQ lives HERE, not in components/ownerrez/faq-section.tsx (which
// re-exports it) — that component has 'use client' at the top, and a plain
// data array exported from a 'use client' module is not safe to import into
// server code: it comes through as something other than a real array in the
// server bundle. Confirmed the hard way — importing it from there prerendered
// fine in dev but threw "MARKETING_FAQ.map is not a function" during
// `next build`'s static generation pass. json-ld.ts has no 'use client'
// directive, so both the Server Component (page.tsx, via buildJsonLd) and the
// Client Component (faq-section.tsx) can safely import the same array from
// here — same shape as app/hosts/json-ld.ts already uses for FAQ_ITEMS.
//
// The SoftwareApplication node's @id is the SAME literal
// `${marketingUrl}#software` every other page's json-ld.ts uses (marketingUrl
// here is the bare origin from marketingOrigin(), not this page's own
// canonical) — deliberately, not a bug to fix. It is one entity, "FieldStay
// the software," referenced consistently across every page; giving each page
// its own @id would fragment that entity in the eyes of anything reading the
// graph instead of reinforcing it. Only the FAQPage @id is page-specific
// (${OWNERREZ_PATH}#faq), because each page's FAQ content really is distinct.
// ============================================================================

export const OWNERREZ_PATH = '/ownerrez'

export const MARKETING_FAQ = [
  {
    q: 'Does FieldStay replace OwnerRez?',
    a: 'No — FieldStay is a field operations layer that works alongside OwnerRez. OwnerRez handles bookings, rates, and guest communication. FieldStay handles what happens on the ground: turnovers, crew assignments, inventory, maintenance, and owner reporting. They do different jobs and work better together.',
  },
  {
    q: 'How long does setup take?',
    a: 'Connecting OwnerRez takes about 2 minutes via OAuth. Your properties and upcoming bookings typically sync within a few minutes — for larger portfolios, typically within 15 minutes. Most property managers complete full setup — crew invites, checklists, and inventory — in under an hour.',
  },
  {
    q: 'What data syncs from OwnerRez?',
    a: 'FieldStay syncs your properties and your full booking history — not just upcoming stays — on initial connection, so past bookings are already there for reporting from day one. Booking changes in OwnerRez — modifications, cancellations — update in FieldStay automatically via webhooks.',
  },
  {
    q: 'How do my crew members access the app?',
    a: 'Go to Crew, add the person with the "Add Crew Member" form, then click "Invite to App" on their row. They receive a link, create a free account, and install the app to their phone home screen — no App Store required. Crew see only their assigned turnovers and checklists, nothing else.',
  },
  {
    // Shared verbatim with the Hospitable landing page — see lib/faq-content.ts.
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
        '@id': `${marketingUrl}${OWNERREZ_PATH}#faq`,
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
          'Field operations layer for OwnerRez property managers: automated turnovers, crew management, ' +
          'inventory, maintenance work orders, and a no-login vendor portal.',
        featureList: [
          'Automated turnover scheduling from OwnerRez bookings',
          'Crew checklists and assignment',
          'No-login vendor work order portal with invoicing',
          'Asset health scoring and CapEx forecasting',
          'Inventory par levels and restocking',
          'Owner P&L reporting',
          'RepuGuard AI review response drafting',
        ],
        // Same rule as strops/breezeway-alternative: this price must also be
        // visible on the rendered page, not just in the schema — Google
        // suppresses structured data describing content a visitor can't see.
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
