// ============================================================================
// /turno-alternative: comparison landing page, rendered by the shared
// ComparisonPage. Every competitor claim comes from ./comparison-data.ts, which
// cites a public URL and a check date for each one; shared metadata and page
// data live in components/marketing/comparison-page-config.ts.
// ============================================================================

import type { Metadata } from 'next'

import ComparisonPage from '@/components/marketing/ComparisonPage'
import { comparisonDescription, comparisonPageData, comparisonSocial } from '@/components/marketing/comparison-page-config'
import { TURNO_FAQ } from '@/lib/faq-content'
import { marketingUrl } from '@/lib/marketing'
import { COMPARISON_ROWS, RESEARCHED_ON, COMPETITOR_PRICE_CARD, COMPETITOR_PRICING_URL } from './comparison-data'
import { buildJsonLd, TURNO_PATH } from './json-ld'

const CANONICAL = marketingUrl(TURNO_PATH)

export const metadata: Metadata = {
  title: 'Turno Alternative with Published Pricing',
  description: comparisonDescription('Turno'),
  keywords: ['turno alternative', 'fieldstay vs turno', 'turno pricing', 'turno competitors', 'turnoverbnb alternative'],
  alternates: { canonical: CANONICAL },
  ...comparisonSocial('Turno', CANONICAL),
}

// NO AUTH CHECK HERE, ON PURPOSE. See app/strops/page.tsx's header comment.
export default function TurnoAlternativePage() {
  return (
    <ComparisonPage
      data={comparisonPageData({
        competitor: 'Turno',
        heroAnswer:
          'FieldStay is a short-term rental operations platform that covers more than cleaning scheduling. The two biggest practical differences from Turno: FieldStay runs turnovers, vendor work orders, asset tracking and owner reporting in one platform, and it publishes one graduated price for any portfolio up to 150 properties with no sales call.',
        rows: COMPARISON_ROWS,
        researchedOn: RESEARCHED_ON,
        competitorPricingUrl: COMPETITOR_PRICING_URL,
        competitorPriceCard: COMPETITOR_PRICE_CARD,
        faqs: TURNO_FAQ,
        buildJsonLd,
      })}
    />
  )
}
