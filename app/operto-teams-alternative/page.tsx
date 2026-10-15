// ============================================================================
// /operto-teams-alternative: comparison landing page, rendered by the shared
// ComparisonPage. Every competitor claim comes from ./comparison-data.ts, which
// cites a public URL and a check date for each one; shared metadata and page
// data live in components/marketing/comparison-page-config.ts.
// ============================================================================

import type { Metadata } from 'next'

import ComparisonPage from '@/components/marketing/ComparisonPage'
import { comparisonDescription, comparisonPageData, comparisonSocial } from '@/components/marketing/comparison-page-config'
import { OPERTO_FAQ } from '@/lib/faq-content'
import { marketingUrl } from '@/lib/marketing'
import { COMPARISON_ROWS, RESEARCHED_ON, COMPETITOR_PRICE_CARD, COMPETITOR_PRICING_URL } from './comparison-data'
import { buildJsonLd, OPERTO_PATH } from './json-ld'

const CANONICAL = marketingUrl(OPERTO_PATH)

export const metadata: Metadata = {
  title: 'Operto Teams Alternative with Published Pricing',
  description: comparisonDescription('Operto Teams'),
  keywords: ['operto teams alternative', 'fieldstay vs operto teams', 'operto teams pricing', 'vrscheduler alternative'],
  alternates: { canonical: CANONICAL },
  ...comparisonSocial('Operto Teams', CANONICAL),
}

// NO AUTH CHECK HERE, ON PURPOSE. See app/strops/page.tsx's header comment.
export default function OpertoTeamsAlternativePage() {
  return (
    <ComparisonPage
      data={comparisonPageData({
        competitor: 'Operto Teams',
        heroAnswer:
          'FieldStay is a short-term rental operations platform, like Operto Teams. The two biggest practical differences: FieldStay publishes one graduated price for any portfolio up to 150 properties with no demo required, and it is built only for short-term rentals, with automatic crew assignment and link-based vendor work orders.',
        rows: COMPARISON_ROWS,
        researchedOn: RESEARCHED_ON,
        competitorPricingUrl: COMPETITOR_PRICING_URL,
        competitorPriceCard: COMPETITOR_PRICE_CARD,
        faqs: OPERTO_FAQ,
        buildJsonLd,
      })}
    />
  )
}
