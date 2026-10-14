// ============================================================================
// /turno-alternative: comparison landing page, rendered by the shared
// ComparisonPage. Target queries: "turno alternative", "fieldstay vs
// turno", "turno pricing". Every competitor claim comes
// from ./comparison-data.ts, which cites a public URL and a check date for
// each one; unit/guardrails/comparison-page-claims.test.ts enforces the dates.
// ============================================================================

import type { Metadata } from 'next'

import ComparisonPage from '@/components/marketing/ComparisonPage'
import { COMPARISON_ROWS, RESEARCHED_ON, COMPETITOR_PRICE_CARD, COMPETITOR_PRICING_URL } from './comparison-data'
import { TRIAL_OFFER, FIELDSTAY_HIGHLIGHTS } from '@/app/breezeway-alternative/comparison-data'
import { buildJsonLd, serializeJsonLd, TURNO_PATH } from './json-ld'
import { TURNO_FAQ as FAQS } from '@/lib/faq-content'
import { monthlyCostCents } from '@/lib/stripe/brackets'
import { marketingUrl, marketingOrigin, appUrl } from '@/lib/marketing'

const PATH = TURNO_PATH
const CANONICAL = marketingUrl(PATH)

// Worked example quoted in the metadata and the pricing section, computed
// from the real schedule, not typed twice. See lib/stripe/brackets.ts.
const EXAMPLE_QTY = 10
const examplePriceDollars = monthlyCostCents(EXAMPLE_QTY)! / 100

export const metadata: Metadata = {
  title: 'Turno Alternative with Published Pricing',
  description:
    `Looking for a Turno alternative? FieldStay publishes real pricing up to 150 properties, ` +
    `no sales call: ${EXAMPLE_QTY} properties is $${examplePriceDollars}/mo. Free 14-day trial.`,
  keywords: ['turno alternative', 'fieldstay vs turno', 'turno pricing', 'turno competitors', 'turnoverbnb alternative'],
  // Absolute apex canonical, same reasoning as /breezeway-alternative.
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'FieldStay vs Turno: pricing and features compared',
    description: 'Published graduated pricing up to 150 properties, no sales call required. See the full comparison.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FieldStay vs Turno',
    description: 'Transparent per-property pricing, published to 150 properties.',
    images: ['/logo.png'],
  },
}

// NO AUTH CHECK HERE, ON PURPOSE. See app/strops/page.tsx's header comment.
export default function TurnoAlternativePage() {
  return (
    <ComparisonPage
      data={{
        competitor: 'Turno',
        eyebrow: 'FieldStay vs Turno',
        h1: 'Looking for a Turno alternative?',
        heroAnswer:
          'FieldStay is a short-term rental operations platform that covers more than cleaning scheduling. The two biggest practical differences from Turno: FieldStay runs turnovers, vendor work orders, asset tracking and owner reporting in one platform, and it publishes one graduated price for any portfolio up to 150 properties with no sales call.',
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
