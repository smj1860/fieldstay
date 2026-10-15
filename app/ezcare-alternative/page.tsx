// ============================================================================
// /ezcare-alternative: comparison landing page, rendered by the shared
// ComparisonPage. Every competitor claim comes from ./comparison-data.ts, which
// cites a public URL and a check date for each one; shared metadata and page
// data live in components/marketing/comparison-page-config.ts.
// ============================================================================

import type { Metadata } from 'next'

import ComparisonPage from '@/components/marketing/ComparisonPage'
import { comparisonDescription, comparisonPageData, comparisonSocial } from '@/components/marketing/comparison-page-config'
import { EZCARE_FAQ } from '@/lib/faq-content'
import { marketingUrl } from '@/lib/marketing'
import { COMPARISON_ROWS, RESEARCHED_ON, COMPETITOR_PRICE_CARD, COMPETITOR_PRICING_URL } from './comparison-data'
import { buildJsonLd, EZCARE_PATH } from './json-ld'

const CANONICAL = marketingUrl(EZCARE_PATH)

export const metadata: Metadata = {
  title: 'EZCare Alternative with Published Pricing',
  description: comparisonDescription('EZCare'),
  keywords: ['ezcare alternative', 'fieldstay vs ezcare', 'ezcare pricing', 'ezcare competitors'],
  alternates: { canonical: CANONICAL },
  ...comparisonSocial('EZCare', CANONICAL),
}

// NO AUTH CHECK HERE, ON PURPOSE. See app/strops/page.tsx's header comment.
export default function EzcareAlternativePage() {
  return (
    <ComparisonPage
      data={comparisonPageData({
        competitor: 'EZCare',
        heroAnswer:
          'FieldStay is a short-term rental operations platform, like EZCare. The two biggest practical differences: FieldStay publishes one graduated price for any portfolio up to 150 properties with no demo required, and it adds automatic crew assignment, an offline-first crew app and link-based vendor work orders.',
        rows: COMPARISON_ROWS,
        researchedOn: RESEARCHED_ON,
        competitorPricingUrl: COMPETITOR_PRICING_URL,
        competitorPriceCard: COMPETITOR_PRICE_CARD,
        faqs: EZCARE_FAQ,
        buildJsonLd,
      })}
    />
  )
}
