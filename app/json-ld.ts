import { SHARED_LANDING_FAQ_TAIL } from '@/lib/faq-content'
import { buildFaqSoftwareJsonLd } from '@/app/strops/json-ld'

// ============================================================================
// Structured data for the homepage. The @graph scaffolding (FAQPage +
// SoftwareApplication, including why the SoftwareApplication @id is the same
// shared literal on every page) lives in buildFaqSoftwareJsonLd()
// (app/strops/json-ld.ts) — this file supplies only what's actually specific
// to the homepage: the FAQ content and the feature/description copy.
//
// HOMEPAGE_FAQ_ITEMS lives HERE, not in components/landing/homepage-content.tsx
// (which re-exports it) — see app/ownerrez/json-ld.ts's header comment for
// why: that component has 'use client' at the top, and a plain data array
// exported from a 'use client' module is not safe to import into server
// code — it throws "<name>.map is not a function" during `next build`'s
// static generation pass, even though it works fine in dev.
//
// The featureList/description here are the BROADEST of every landing page's
// json-ld.ts — this is the site's general entity, not a segment- or
// integration-specific one, so it names the site's core value props rather
// than leading with any one of them the way /strops (offline) or /ownerrez
// (OwnerRez-specific) do.
// ============================================================================

export const HOMEPAGE_PATH = '/'

// The homepage's FAQ is exactly the tail every integration page appends
// after its own persona-specific entries — the homepage has no persona-
// specific entries of its own, so this IS its whole FAQ array. Kept under
// the HOMEPAGE_FAQ_ITEMS name since components/landing/homepage-content.tsx
// already imports it by that name.
export const HOMEPAGE_FAQ_ITEMS = SHARED_LANDING_FAQ_TAIL

export function buildJsonLd(marketingUrl: string) {
  return buildFaqSoftwareJsonLd(marketingUrl, {
    faqPath: HOMEPAGE_PATH,
    faqItems: HOMEPAGE_FAQ_ITEMS,
    description:
      'Property operations platform for short-term rental managers: automated turnovers, an offline-' +
      'first crew app, a no-login vendor portal, asset health and CapEx forecasting, and a self-funding ' +
      'guest guidebook.',
    featureList: [
      'Automated turnover scheduling from PMS bookings',
      'Offline-first crew app with photo capture',
      'No-login vendor work order portal with invoicing',
      'Asset health scoring and CapEx forecasting',
      'Inventory par levels with automatic restocking',
      'Owner P&L reporting portal',
      'Self-funding guest guidebook with local business sponsors',
      'RepuGuard AI review response drafting',
    ],
  })
}

export { serializeJsonLd } from '@/app/strops/json-ld'
