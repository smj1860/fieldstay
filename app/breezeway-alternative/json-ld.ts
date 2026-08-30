import { BREEZEWAY_FAQ as FAQS } from '@/lib/faq-content'

// ============================================================================
// Structured data for /breezeway-alternative. Same pattern as
// app/strops/json-ld.ts (FAQPage + SoftwareApplication) — serializeJsonLd is
// imported from there rather than re-implemented, since it's a pure escaping
// utility with no strops-specific coupling and this codebase's whole point in
// extracting it once was to not have two copies of injection-boundary logic.
// ============================================================================

export const BREEZEWAY_PATH = '/breezeway-alternative'

export function buildJsonLd(marketingUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${marketingUrl}${BREEZEWAY_PATH}#faq`,
        mainEntity: FAQS.map((f) => ({
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
          'Offline-first crew PWA — no app store install',
          'No-login, no-app vendor work order portal',
          'Published graduated pricing, calculable up to 150 properties',
          'Owner P&L portal',
          'Asset health scoring and CapEx forecasting',
          'RepuGuard AI review response drafting',
          'Inventory par levels with automatic Kroger cart building',
        ],
        // Same rule as strops's json-ld.ts: this price must also be visible,
        // in human-readable form, on the rendered page — Google suppresses
        // structured data that describes content the visitor can't actually
        // see. unit/pages/breezeway-alternative.test.ts checks both halves
        // against lib/stripe/brackets.ts directly, not the literal '49'.
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
