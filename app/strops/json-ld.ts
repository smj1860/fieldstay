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
        // The price here must also appear, in some human-readable form, on
        // the rendered page (page.tsx's hero currently says "Starting at
        // $49/month") -- Google's structured data guidelines don't allow
        // marking up content that isn't visible to users, and a rich result
        // can get suppressed over exactly this kind of mismatch. Verified
        // 2026-08-10 after this page shipped with no visible price at all
        // for its first several weeks live. unit/pages/strops.test.ts
        // enforces both halves: this price against the real graduated
        // schedule's anchor (lib/stripe/brackets.ts monthlyCostCents(1)),
        // and that same anchor against the visible page text.
        //
        // '49' is the true minimum price of any FieldStay subscription as of
        // the 2026-08-29 graduated-pricing rebuild — the $49 anchor for
        // property 1 — not a flat tier price the way '89' was. "Starting at"
        // is the accurate framing now; a customer's actual bill scales with
        // property count from there.
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

export interface QaFaqItem {
  q: string
  a: string
}

export interface FaqSoftwareOffer {
  price: string
  description: string
}

export interface FaqSoftwareJsonLdOptions {
  faqPath: string
  faqItems: readonly QaFaqItem[]
  description: string
  featureList: readonly string[]
  /** Defaults to the $49 site-wide anchor — pass this to override, e.g. /hosts's tier-specific price. */
  offer?: FaqSoftwareOffer
}

/**
 * Shared FAQPage + SoftwareApplication builder for every landing page EXCEPT
 * this one and /breezeway-alternative, which predate this extraction and use
 * FaqItem's `{ question, answer }` shape (lib/faq-content.ts) rather than the
 * `{ q, a }` shape every other page's FAQ arrays use — see the header comment
 * on this file's own buildJsonLd() below for that shape, unchanged by this
 * addition.
 *
 * Extracted 2026-08-31 after SonarCloud flagged 70-80% duplication between
 * app/ownerrez/json-ld.ts and app/hospitable/json-ld.ts: with the FAQ shape
 * and the "site's price must also be visible on the page" rule already
 * documented per-file, what was left duplicated was the entire @graph
 * scaffolding itself — identical apart from the FAQ content and feature copy
 * each page's buildJsonLd() supplied.
 */
export function buildFaqSoftwareJsonLd(marketingUrl: string, opts: FaqSoftwareJsonLdOptions) {
  const price = opts.offer?.price ?? '49'
  const offerDescription =
    opts.offer?.description ??
    `Starting at $${price}/month for your first property. 14-day free trial, no credit card required.`

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${marketingUrl}${opts.faqPath}#faq`,
        mainEntity: opts.faqItems.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'SoftwareApplication',
        // Deliberately the SAME literal on every page — see
        // app/ownerrez/json-ld.ts's header comment (pre-extraction) for why:
        // one "FieldStay the software" entity referenced consistently across
        // the site, not a fragmented per-page id.
        '@id': `${marketingUrl}#software`,
        name: 'FieldStay',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, iOS, Android',
        description: opts.description,
        featureList: opts.featureList,
        // Same rule as this file's own buildJsonLd(): this price must also be
        // visible on the rendered page, not just in the schema — Google
        // suppresses structured data describing content a visitor can't see.
        offers: {
          '@type': 'Offer',
          price,
          priceCurrency: 'USD',
          description: offerDescription,
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
