import { MARKETING_TRIAL_FAQ, MARKETING_OFFLINE_FAQ, HOSTS_CREW_REQUIRED_FAQ, HOSTS_REPLACES_PMS_FAQ } from '@/lib/faq-content'
import { monthlyCostCents } from '@/lib/stripe/brackets'
import { buildFaqSoftwareJsonLd } from '@/app/strops/json-ld'

// ============================================================================
// Structured data for /hosts. The @graph scaffolding (FAQPage +
// SoftwareApplication, including why the SoftwareApplication @id is the same
// shared literal on every page) lives in buildFaqSoftwareJsonLd()
// (app/strops/json-ld.ts) — this file supplies only what's actually specific
// to /hosts: the FAQ content, the feature/description copy, and (unlike every
// other page) a non-default `offer` — the Hosts-tier price, not the $49
// site-wide anchor buildFaqSoftwareJsonLd() otherwise assumes.
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

  return buildFaqSoftwareJsonLd(marketingUrl, {
    faqPath: HOSTS_PATH,
    faqItems: FAQ_ITEMS,
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
    // This price must also be visible on the rendered page, not just in the
    // schema — and here it is the Hosts-tier anchor specifically (numerically
    // identical today to the site-wide graduated schedule's property-1 price,
    // but a distinct concept — see HOSTS_PRICE's own comment in page.tsx),
    // which is why it overrides buildFaqSoftwareJsonLd()'s $49 default rather
    // than relying on it.
    offer: {
      price,
      description: `Starting at $${price}/month for 1-4 properties. 14-day free trial, no credit card required.`,
    },
  })
}

export { serializeJsonLd } from '@/app/strops/json-ld'
