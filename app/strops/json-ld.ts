import { STROPS_FAQ as FAQS } from '@/lib/faq-content'

// ============================================================================
// Structured data for /offline-turnover-app.
//
// Extracted from page.tsx so the test can exercise THIS function rather than
// reimplementing the escaping next to it — a test that re-derives the logic it
// is checking proves only that the author can write the same bug twice.
// ============================================================================

export const STROPS_PATH = '/strops'

export function buildJsonLd(marketingUrl: string) {
  // One payload, two schema types. FAQPage drives the "People also ask" rich
  // result; SoftwareApplication is what makes the product eligible to appear
  // as an entity rather than only a blue link.
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${marketingUrl}${STROPS_PATH}#faq`,
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
          'Offline-first short-term rental operations platform. The crew app works with no cell service: ' +
          'checklists, photos, inventory counts and turnover completion all function offline and sync ' +
          'automatically when connectivity returns.',
        featureList: [
          'Works offline with no cell service',
          'Offline checklists with photo capture',
          'Automatic background sync',
          'Turnover scheduling and crew assignment',
          'Inventory par levels and restocking',
          'Maintenance work orders and vendor portal',
          'Owner P&L reporting',
        ],
        offers: {
          '@type': 'Offer',
          price: '89',
          priceCurrency: 'USD',
          description: 'Hosts plan, 1–4 properties. 14-day free trial, no credit card required.',
        },
      },
    ],
  }
}

/**
 * Serialize for emission as a `<script>` TEXT CHILD, not via
 * dangerouslySetInnerHTML.
 *
 * This codebase has zero uses of dangerouslySetInnerHTML, and the ESLint rule
 * banning it says raw HTML "needs DOMPurify and a CLAUDE.md update first" — a
 * structured-data blob is not what that exception is for.
 *
 * ── What this escaping is and is not ────────────────────────────────────────
 *
 * The usual justification given for JSON-LD escaping is "React would mangle
 * the ampersands". That is FALSE for <script>, which is a raw-text element:
 * React emits its children verbatim, "&" and all. And React separately
 * neutralises "</script" on its own, rewriting it as "</\u0073cript".
 *
 * Both of those were asserted, not assumed — component/offline-jsonld.test.tsx
 * pins each one, and the first draft of this comment claimed the opposite
 * until those tests said otherwise.
 *
 * So this is defence in depth rather than a fix for a live bug, and it is
 * worth three lines because both behaviours are React implementation details,
 * not API contract. An injection boundary that silently depends on a
 * framework internal is the kind of implicit assumption this repo makes
 * explicit everywhere else. If a React upgrade changes either behaviour the
 * control tests fail, and this function is already standing in the gap.
 *
 * \u003c / \u003e / \u0026 are valid JSON string escapes, so the payload
 * parses back to exactly the same values either way.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}
