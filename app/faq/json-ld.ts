import { buildFaqSoftwareJsonLd } from '@/app/strops/json-ld'
import { PUBLIC_FAQ } from '@/lib/faq-content'

// ============================================================================
// Structured data for /faq. The @graph scaffolding (FAQPage +
// SoftwareApplication, and why the SoftwareApplication @id is the same shared
// literal on every page) lives in buildFaqSoftwareJsonLd().
//
// The FAQ content is NOT declared here, unlike every other page that calls
// that builder. Those pages each own a hand-written FAQ array; this page's
// whole premise is that its twelve questions are PUBLIC_FAQ, selected out of
// the same FAQ_CATEGORIES the in-app help renders. Declaring them again here
// would mean the rich result could claim an answer the page does not show, and
// Google treats a FAQPage whose markup and visible text disagree as a markup
// violation rather than a harmless mismatch.
//
// buildFaqSoftwareJsonLd takes the `{ q, a }` shape the older landing pages
// use; PUBLIC_FAQ is FaqItem's `{ question, answer }`, so it is mapped rather
// than reshaped at the source. Both shapes are load-bearing where they are
// (see that builder's header comment), so the adapter belongs here, at the one
// seam between them.
// ============================================================================

export { serializeJsonLd } from '@/app/strops/json-ld'

export function buildJsonLd(marketingUrl: string) {
  return buildFaqSoftwareJsonLd(marketingUrl, {
    faqPath: '/faq',
    faqItems: PUBLIC_FAQ.map((f) => ({ q: f.question, a: f.answer })),
    description:
      'Common questions about FieldStay, the property operations platform for short-term rental managers: what it costs, how it connects to your PMS, what your crew and your owners can see, and how your data is handled.',
    featureList: [
      'Turnover scheduling and crew assignment',
      'Offline-capable crew app',
      'Maintenance work orders and vendor compliance',
      'Self-correcting inventory par levels',
      'Owner portal with per-property profit and loss',
      'Asset health and CapEx forecasting',
    ],
  })
}
