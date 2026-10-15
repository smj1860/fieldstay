import type { FaqItem } from '@/lib/faq-content'
import { monthlyCostCents } from '@/lib/stripe/brackets'

// ============================================================================
// Structured data shared by every "<competitor> alternative" page: a FAQPage
// built from that page's own FAQ array, and the one SoftwareApplication node.
// Same shape as app/breezeway-alternative/json-ld.ts, which still carries its
// own copy until that page migrates onto ComparisonPage.
//
// The Offer price is the real schedule's anchor, computed rather than typed:
// Google suppresses structured data that describes content the visitor cannot
// see, and the shared page renders the same figure in its hero.
// ============================================================================

export function buildComparisonJsonLd(marketingUrl: string, path: string, faqs: readonly FaqItem[]) {
  const entryPrice = monthlyCostCents(1)! / 100
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${marketingUrl}${path}#faq`,
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${marketingUrl}#software`,
        name: 'FieldStay',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, iOS, Android',
        description:
          'Short-term rental operations platform: offline-first crew app, no-login vendor work orders, ' +
          'graduated per-property pricing published up to 150 properties with no sales call required.',
        featureList: [
          'Offline-first crew PWA, no app store install',
          'No-login, no-app vendor work order portal',
          'Published graduated pricing, calculable up to 150 properties',
          'Owner P&L portal',
          'Asset health scoring and CapEx forecasting',
          'RepuGuard AI review response drafting',
          'Inventory par levels with automatic Kroger cart building',
        ],
        offers: {
          '@type': 'Offer',
          price: String(entryPrice),
          priceCurrency: 'USD',
          description: `Starting at $${entryPrice}/month for your first property. 14-day free trial, no credit card required.`,
        },
      },
    ],
  }
}
