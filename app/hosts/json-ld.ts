import { MARKETING_TRIAL_FAQ, MARKETING_OFFLINE_FAQ, HOSTS_CREW_REQUIRED_FAQ, HOSTS_REPLACES_PMS_FAQ } from '@/lib/faq-content'
import { monthlyCostCents } from '@/lib/stripe/brackets'

// ============================================================================
// Structured data for /hosts. Same pattern as app/strops/json-ld.ts and
// app/breezeway-alternative/json-ld.ts (FAQPage + SoftwareApplication) —
// serializeJsonLd is imported from strops rather than reimplemented.
//
// FAQ_ITEMS lives HERE rather than in page.tsx (unlike the plain-const
// pattern in ownerrez/hospitable's faq-section.tsx components) specifically
// so page.tsx can import it FROM this file — importing it the other way
// round would make page.tsx and json-ld.ts import each other.
//
// offers.price is monthlyCostCents(1), the exact same call page.tsx's
// HOSTS_PRICE derives from (via pricingTiers()'s Hosts-tier `monthly` field —
// see plan-tiers.ts, which hardcodes the Hosts tier to monthlyCostCents(1)
// regardless of the entry-features array passed in). Computed here directly
// from lib/stripe/brackets.ts, the one real source both values trace back to,
// so they cannot drift apart even though neither imports the other.
//
// See app/ownerrez/json-ld.ts's header comment for why the
// SoftwareApplication @id is the same shared literal on every page.
// ============================================================================

export const HOSTS_PATH = '/hosts'

export const FAQ_ITEMS = [
  { q: HOSTS_CREW_REQUIRED_FAQ.question, a: HOSTS_CREW_REQUIRED_FAQ.answer },
  { q: HOSTS_REPLACES_PMS_FAQ.question, a: HOSTS_REPLACES_PMS_FAQ.answer },
  { q: MARKETING_OFFLINE_FAQ.question, a: MARKETING_OFFLINE_FAQ.answer },
  { q: MARKETING_TRIAL_FAQ.question, a: MARKETING_TRIAL_FAQ.answer },
] as const

export function buildJsonLd(marketingUrl: string) {
  const price = String(monthlyCostCents(1)! / 100)

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${marketingUrl}${HOSTS_PATH}#faq`,
        mainEntity: FAQ_ITEMS.map((f) => ({
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
          'Field operations app for solo short-term rental hosts running 1-4 properties: offline turnover ' +
          'checklists, a no-login vendor portal, owner-grade CapEx forecasting, and a self-funding guest guidebook.',
        featureList: [
          'Offline turnover checklist with photo capture',
          'Self-funding guest guidebook with local business sponsors',
          'No-login vendor work order portal with invoicing',
          'Asset health scoring and CapEx forecasting',
          'RepuGuard AI review response drafting',
          'Airbnb/VRBO iCal sync, or connect OwnerRez/Hospitable',
        ],
        // Same rule as strops/breezeway-alternative: this price must also be
        // visible on the rendered page, not just in the schema — and here it
        // is the Hosts-tier anchor specifically (numerically identical today
        // to the site-wide graduated schedule's property-1 price, but a
        // distinct concept — see HOSTS_PRICE's own comment in page.tsx).
        offers: {
          '@type': 'Offer',
          price,
          priceCurrency: 'USD',
          description: `Starting at $${price}/month for 1-4 properties. 14-day free trial, no credit card required.`,
        },
      },
    ],
  }
}

export { serializeJsonLd } from '@/app/strops/json-ld'
