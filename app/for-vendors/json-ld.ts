import { VENDOR_NO_ACCOUNT_FAQ, VENDOR_PAYOUT_TIMING_FAQ, VENDOR_MULTIPLE_PMS_FAQ } from '@/lib/faq-content'
import { buildFaqSoftwareJsonLd } from '@/app/strops/json-ld'

// ============================================================================
// Structured data for /for-vendors. The @graph scaffolding (FAQPage +
// SoftwareApplication, including why the SoftwareApplication @id is the same
// shared literal on every page) lives in buildFaqSoftwareJsonLd()
// (app/strops/json-ld.ts) — this file supplies only what's actually specific
// to /for-vendors: the FAQ content and the feature/description copy,
// written from the VENDOR's-eye view (no-login access, offline-capable
// checklist completion is NOT claimed here — vendors use the token-based
// vendor portal, not the crew PWA; those are separate systems with separate
// auth) rather than the PM-facing framing every other page uses.
//
// offer: null — vendors don't pay for FieldStay, so there is no price to
// quote here at all, not even the $49 floor.
// ============================================================================

export const FOR_VENDORS_PATH = '/for-vendors'

export const FAQ_ITEMS = [
  { q: VENDOR_NO_ACCOUNT_FAQ.question, a: VENDOR_NO_ACCOUNT_FAQ.answer },
  { q: VENDOR_PAYOUT_TIMING_FAQ.question, a: VENDOR_PAYOUT_TIMING_FAQ.answer },
  { q: VENDOR_MULTIPLE_PMS_FAQ.question, a: VENDOR_MULTIPLE_PMS_FAQ.answer },
] as const

export function buildJsonLd(marketingUrl: string) {
  return buildFaqSoftwareJsonLd(marketingUrl, {
    faqPath: FOR_VENDORS_PATH,
    faqItems: FAQ_ITEMS,
    description:
      'FieldStay work order portal for vendors and contractors: receive work orders and get paid with no ' +
      'account, no app, and no login required.',
    featureList: [
      'No-login, no-app work order access via a secure link',
      'View property details and the authorized spending limit before starting',
      'Submit an itemized quote or invoice from your phone',
      'Mark jobs complete with photos',
      'Get paid via Stripe Connect directly to your bank account',
    ],
    offer: null,
  })
}

export { serializeJsonLd } from '@/app/strops/json-ld'
