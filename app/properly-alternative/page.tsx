// ============================================================================
// /properly-alternative: comparison landing page, rendered by the shared
// ComparisonPage. Every competitor claim comes from ./comparison-data.ts, which
// cites a public URL and a check date for each one; shared metadata and page
// data live in components/marketing/comparison-page-config.ts.
// ============================================================================

import type { Metadata } from 'next'

import ComparisonPage from '@/components/marketing/ComparisonPage'
import { comparisonDescription, comparisonPageData, comparisonSocial } from '@/components/marketing/comparison-page-config'
import { PROPERLY_FAQ } from '@/lib/faq-content'
import { marketingUrl } from '@/lib/marketing'
import { COMPARISON_ROWS, RESEARCHED_ON, COMPETITOR_PRICE_CARD, COMPETITOR_PRICING_URL } from './comparison-data'
import { buildJsonLd, PROPERLY_PATH } from './json-ld'

const CANONICAL = marketingUrl(PROPERLY_PATH)

export const metadata: Metadata = {
  title: 'Properly Alternative with Published Pricing',
  description: comparisonDescription('Properly'),
  keywords: ['properly alternative', 'fieldstay vs properly', 'properly pricing', 'getproperly alternative'],
  alternates: { canonical: CANONICAL },
  ...comparisonSocial('Properly', CANONICAL),
}

// NO AUTH CHECK HERE, ON PURPOSE. See app/strops/page.tsx's header comment.
export default function ProperlyAlternativePage() {
  return (
    <ComparisonPage
      data={comparisonPageData({
        competitor: 'Properly',
        heroAnswer:
          'FieldStay is a short-term rental operations platform with photo-timestamped checklists, like Properly. The two biggest practical differences: FieldStay covers vendor work orders, asset tracking and owner reporting alongside turnovers, and it publishes one graduated price for any portfolio up to 150 properties with no sales call.',
        rows: COMPARISON_ROWS,
        researchedOn: RESEARCHED_ON,
        competitorPricingUrl: COMPETITOR_PRICING_URL,
        competitorPriceCard: COMPETITOR_PRICE_CARD,
        faqs: PROPERLY_FAQ,
        buildJsonLd,
      })}
    />
  )
}
