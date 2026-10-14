// ============================================================================
// /ezcare-alternative: comparison landing page, rendered by the shared
// ComparisonPage. Target queries: "ezcare alternative", "fieldstay vs
// ezcare", "ezcare pricing". Every competitor claim comes
// from ./comparison-data.ts, which cites a public URL and a check date for
// each one; unit/guardrails/comparison-page-claims.test.ts enforces the dates.
// ============================================================================

import type { Metadata } from 'next'

import ComparisonPage from '@/components/marketing/ComparisonPage'
import { COMPARISON_ROWS, RESEARCHED_ON, COMPETITOR_PRICE_CARD, COMPETITOR_PRICING_URL } from './comparison-data'
import { TRIAL_OFFER, FIELDSTAY_HIGHLIGHTS } from '@/app/breezeway-alternative/comparison-data'
import { buildJsonLd, serializeJsonLd, EZCARE_PATH } from './json-ld'
import { EZCARE_FAQ as FAQS } from '@/lib/faq-content'
import { monthlyCostCents } from '@/lib/stripe/brackets'
import { marketingUrl, marketingOrigin, appUrl } from '@/lib/marketing'

const PATH = EZCARE_PATH
const CANONICAL = marketingUrl(PATH)

// Worked example quoted in the metadata and the pricing section, computed
// from the real schedule, not typed twice. See lib/stripe/brackets.ts.
const EXAMPLE_QTY = 10
const examplePriceDollars = monthlyCostCents(EXAMPLE_QTY)! / 100

export const metadata: Metadata = {
  title: 'EZCare Alternative with Published Pricing',
  description:
    `Looking for a EZCare alternative? FieldStay publishes real pricing up to 150 properties, ` +
    `no sales call: ${EXAMPLE_QTY} properties is $${examplePriceDollars}/mo. Free 14-day trial.`,
  keywords: ['ezcare alternative', 'fieldstay vs ezcare', 'ezcare pricing', 'ezcare competitors'],
  // Absolute apex canonical, same reasoning as /breezeway-alternative.
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'FieldStay vs EZCare: pricing and features compared',
    description: 'Published graduated pricing up to 150 properties, no sales call required. See the full comparison.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FieldStay vs EZCare',
    description: 'Transparent per-property pricing, published to 150 properties.',
    images: ['/logo.png'],
  },
}

// NO AUTH CHECK HERE, ON PURPOSE. See app/strops/page.tsx's header comment.
export default function EzcareAlternativePage() {
  return (
    <ComparisonPage
      data={{
        competitor: 'EZCare',
        eyebrow: 'FieldStay vs EZCare',
        h1: 'Looking for a EZCare alternative?',
        heroAnswer:
          'FieldStay is a short-term rental operations platform, like EZCare. The two biggest practical differences: FieldStay publishes one graduated price for any portfolio up to 150 properties with no demo required, and it adds automatic crew assignment, an offline-first crew app and link-based vendor work orders.',
        rows: COMPARISON_ROWS,
        researchedOn: RESEARCHED_ON,
        competitorPricingUrl: COMPETITOR_PRICING_URL,
        competitorPriceCard: COMPETITOR_PRICE_CARD,
        trialOffer: TRIAL_OFFER,
        highlights: FIELDSTAY_HIGHLIGHTS,
        faqs: FAQS,
        ctaHref: appUrl('/signup?next=/onboarding'),
        jsonLd: serializeJsonLd(buildJsonLd(marketingOrigin())),
        exampleQty: EXAMPLE_QTY,
        examplePriceDollars,
      }}
    />
  )
}
