import {
  ENTERPRISE_SLA_FAQ, ENTERPRISE_SECURITY_FAQ, ENTERPRISE_TEAM_ACCESS_FAQ, ENTERPRISE_MIGRATION_FAQ,
  MARKETING_OFFLINE_FAQ, MARKETING_TRIAL_FAQ,
} from '@/lib/faq-content'
import { buildFaqSoftwareJsonLd } from '@/app/strops/json-ld'

// ============================================================================
// Structured data for /enterprise. The @graph scaffolding (FAQPage +
// SoftwareApplication, including why the SoftwareApplication @id is the same
// shared literal on every page) lives in buildFaqSoftwareJsonLd()
// (app/strops/json-ld.ts) — this file supplies only what's actually specific
// to /enterprise: the FAQ content and the feature/description copy.
//
// FAQ_ITEMS lives HERE rather than in page.tsx, same reason as
// app/hosts/json-ld.ts's FAQ_ITEMS — so page.tsx can import it FROM this
// file without the two importing each other.
//
// offer: null — deliberately no `offers` node. Every other page's schema
// names the real $49 site-wide floor because it's genuinely this page's
// starting price; on /enterprise the audience is above the self-serve
// ceiling, and quoting $49 as "the price" in a rich-result snippet would be
// technically true but misleading in context. See buildFaqSoftwareJsonLd()'s
// FaqSoftwareJsonLdOptions.offer doc comment.
// ============================================================================

export const ENTERPRISE_PATH = '/enterprise'

export const FAQ_ITEMS = [
  { q: ENTERPRISE_SLA_FAQ.question, a: ENTERPRISE_SLA_FAQ.answer },
  { q: ENTERPRISE_SECURITY_FAQ.question, a: ENTERPRISE_SECURITY_FAQ.answer },
  { q: ENTERPRISE_TEAM_ACCESS_FAQ.question, a: ENTERPRISE_TEAM_ACCESS_FAQ.answer },
  { q: ENTERPRISE_MIGRATION_FAQ.question, a: ENTERPRISE_MIGRATION_FAQ.answer },
  { q: MARKETING_OFFLINE_FAQ.question, a: MARKETING_OFFLINE_FAQ.answer },
  { q: MARKETING_TRIAL_FAQ.question, a: MARKETING_TRIAL_FAQ.answer },
] as const

export function buildJsonLd(marketingUrl: string) {
  return buildFaqSoftwareJsonLd(marketingUrl, {
    faqPath: ENTERPRISE_PATH,
    faqItems: FAQ_ITEMS,
    description:
      'FieldStay for large short-term rental portfolios and multi-location operations: unlimited properties, ' +
      'SLA-backed uptime, and volume pricing above the self-serve ceiling.',
    featureList: [
      'Unlimited properties, no self-serve ceiling',
      'Volume pricing above 150 properties',
      'SLA-backed uptime and dedicated support',
      'Custom onboarding',
      'Portfolio-wide reporting across every property you manage',
      'Offline-first crew app and no-login vendor work order portal',
    ],
    offer: null,
  })
}

export { serializeJsonLd } from '@/app/strops/json-ld'
