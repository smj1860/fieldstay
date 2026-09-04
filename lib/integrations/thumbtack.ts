import 'server-only'

import type { WoCategory, CrewRole } from '@/types/database'

// ============================================================================
// Thumbtack Request Flow Widget — scaffolding only.
//
// "Find a Pro" entry points on the Crew, Maintenance, and Work Order detail
// pages, for the case where a PM has no assigned vendor/crew for a job.
// FieldStay is the PARTNER here (like Puls, Networx, Nextdoor in Thumbtack's
// own partner-examples deck) surfacing Thumbtack's marketplace, not a
// Thumbtack business itself.
//
// Two pieces, in very different states of readiness:
//   - buildRequestFlowUrl() — fully implemented. The widget URL's shape is
//     completely documented (Thumbtack's Widgets → Request Flow Widget doc):
//     {{environment}}/embed/request-flow?category_pk=...&service_pk=...&
//     zip_code=...&utm_medium=partnerships&utm_source=...
//   - searchThumbtackPros() — a stub that throws. Thumbtack's partner
//     /businesses/search API (which returns up to 30 pros per category+zip,
//     each with its own service_pk and a ready-made requestFlowUrl) has NEVER
//     been documented to us beyond its existence: no base API host, no auth
//     mechanism, no confirmed response field names. Guessing at those and
//     shipping a fetch() that LOOKS complete would be worse than an honest
//     stub — it would silently 401/404 in a way that reads as "Thumbtack is
//     down" rather than "this was never finished." Fill this in once a
//     Thumbtack rep confirms: (1) the /businesses/search base URL, (2) the
//     auth header/scheme, (3) the exact response schema (this file's
//     ThumbtackPro type is a best guess from the Request Flow Widget and
//     Discovery Lite docs, NOT a confirmed schema).
//
// isThumbtackConfigured() gates every call site — CLAUDE.md's SMS_ENABLED
// pattern: fail closed and hide the feature entirely rather than show a
// broken CTA when unconfigured (see the three THUMBTACK_* entries in
// lib/env.ts).
// ============================================================================

/** The {{environment}} values Thumbtack's docs enumerate. */
export type ThumbtackEnvironment = 'https://staging-partner.thumbtack.com' | 'https://thumbtack.com'

/**
 * FieldStay's own category enums, mapped to a Thumbtack category_pk.
 *
 * Thumbtack's taxonomy (476 leaf categories, confirmed 2026-09 from their
 * category_pk export) is far more granular than WoCategory/CrewRole, so this
 * is a many-to-one collapse, not a lookup — a few entries (hvac, windows_doors,
 * pool, structural) each pick one Thumbtack leaf out of several plausible
 * ones. Precision here only affects which pros surface in that one search;
 * it's never persisted, and a PM saving a pro as a FieldStay vendor picks
 * `vendor_specialty` independently in that form, so it doesn't need to be
 * exact.
 *
 * `other` has no Thumbtack equivalent and stays unmapped by design —
 * searchThumbtackProsAction() already handles a null mapping by returning
 * an error rather than guessing.
 */
export type ThumbtackCategoryKey = WoCategory | CrewRole

export const THUMBTACK_CATEGORY_MAP: Readonly<Record<ThumbtackCategoryKey, string | null>> = {
  hvac:          '166577475042034098', // Central Air Conditioning Repair or Maintenance
  plumbing:      '283300384734896599', // Emergency Plumbing
  electrical:    '122769389996753250', // Electrical and Wiring Repair
  appliance:     '166573972257055145', // Appliance Repair or Maintenance
  cleaning:      '219264413294461288', // House Cleaning
  landscaping:   '240123621172183344', // Full Service Lawn Care
  roofing:       '174455213291954651', // Roof Repair or Maintenance
  flooring:      '206934703503376680', // Floor Repair
  windows_doors: '168387209743442385', // Door Repair
  pest_control:  '133665232699441654', // Pest Control Services
  pool:          '194910465719878122', // Swimming Pool Repair
  structural:    '152394038374179185', // Foundation Repair
  general:       '109125193401647362', // Handyman
  other:         null,                 // no Thumbtack equivalent — deliberate
  maintenance:   '109125193401647362', // Handyman — crew_role's general fix-it category, same as `general`
}

/** A pro returned by /businesses/search — see the module header re: this shape being unconfirmed. */
export interface ThumbtackPro {
  businessPk:     string
  businessName:   string
  /** Thumbtack API field name unconfirmed — a per-business search identifier used to build that pro's request-flow URL. */
  servicePk:      string
  /** Already fully formed by Thumbtack's API per the docs — prefer this over calling buildRequestFlowUrl() yourself when it's present. */
  requestFlowUrl: string
  rating?:        number
  numReviews?:    number
}

interface RequestFlowUrlParams {
  environment: ThumbtackEnvironment
  categoryPk:  string
  servicePk:   string
  zipCode?:    string
  utmSource:   string
  /** Extra utm_ params beyond utm_medium/utm_source, e.g. { utm_campaign: 'crew-page' }. Keys must be utm_-prefixed. */
  extraUtmParams?: Record<string, string>
}

/**
 * Builds a Request Flow Widget URL directly, for the case where a specific
 * pro's service_pk is already known (e.g. returned by /businesses/search)
 * and there's no need to re-derive it from Thumbtack's own requestFlowUrl.
 *
 * utm_medium is always 'partnerships' per Thumbtack's spec — not a caller
 * option.
 */
export function buildRequestFlowUrl(params: RequestFlowUrlParams): string {
  const url = new URL('/embed/request-flow', params.environment)
  url.searchParams.set('category_pk', params.categoryPk)
  url.searchParams.set('service_pk', params.servicePk)
  if (params.zipCode) url.searchParams.set('zip_code', params.zipCode)
  url.searchParams.set('utm_medium', 'partnerships')
  url.searchParams.set('utm_source', params.utmSource)
  for (const [key, value] of Object.entries(params.extraUtmParams ?? {})) {
    if (!key.startsWith('utm_')) {
      throw new Error(`extraUtmParams key "${key}" must be utm_-prefixed`)
    }
    url.searchParams.set(key, value)
  }
  return url.toString()
}

/** True once all three THUMBTACK_* env vars are set — see lib/env.ts. */
export function isThumbtackConfigured(): boolean {
  return Boolean(
    process.env.THUMBTACK_ENVIRONMENT &&
    process.env.THUMBTACK_API_KEY &&
    process.env.THUMBTACK_UTM_SOURCE
  )
}

/**
 * NOT YET IMPLEMENTED — see the module header. Throws unconditionally so a
 * call site fails loudly (and visibly, in the Server Action's catch block)
 * rather than silently returning an empty list that reads as "no pros
 * nearby" instead of "this isn't built yet."
 */
export async function searchThumbtackPros(_params: {
  categoryKey: ThumbtackCategoryKey
  zipCode:     string | null
}): Promise<ThumbtackPro[]> {
  throw new Error(
    'Thumbtack /businesses/search is not yet implemented — the base API URL, auth ' +
    'mechanism, and response schema need confirming with a Thumbtack rep first. ' +
    'See lib/integrations/thumbtack.ts.'
  )
}
