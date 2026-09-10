import 'server-only'

import { THUMBTACK_TIMEOUT_MS, isTimeoutError } from '@/lib/http/timeout'
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
// Three pieces, in different states of readiness:
//   - buildRequestFlowUrl() — fully implemented. The widget URL's shape is
//     completely documented (Thumbtack's Widgets → Request Flow Widget doc):
//     {{environment}}/embed/request-flow?category_pk=...&service_pk=...&
//     zip_code=...&utm_medium=partnerships&utm_source=...
//   - getThumbtackAccessToken() — fully implemented. Thumbtack's Environments
//     doc confirms standard OAuth2: a client_credentials grant against
//     {authBase}/oauth2/token with a per-environment clientID/clientSecret.
//     (The doc names the Authorization URL too, for an interactive
//     authorization_code flow — not used here, since this is a server-to-
//     server call with no end user to redirect.)
//   - searchThumbtackPros() — still a stub past the token fetch. Thumbtack's
//     partner /businesses/search API (which returns up to 30 pros per
//     category+zip, each with its own service_pk and a ready-made
//     requestFlowUrl) has a confirmed HOST now (resolveThumbtackEnvironment())
//     but not a confirmed PATH, query params, or response schema. Guessing at
//     those and shipping a fetch() that LOOKS complete would be worse than an
//     honest stub — it would silently 404/malform in a way that reads as
//     "Thumbtack is down" rather than "this was never finished." Fill this in
//     once a Thumbtack rep confirms: (1) the exact /businesses/search path
//     and query params, (2) the exact response schema (this file's
//     ThumbtackPro type is confirmed against Discovery Lite's schema, NOT
//     against /businesses/search's — they may not be the same endpoint).
//
// isThumbtackConfigured() gates every call site — CLAUDE.md's SMS_ENABLED
// pattern: fail closed and hide the feature entirely rather than show a
// broken CTA when unconfigured (see the four THUMBTACK_* entries in
// lib/env.ts).
// ============================================================================

/** The {{environment}} values Thumbtack's docs enumerate. */
export type ThumbtackEnvironment = 'https://staging-partner.thumbtack.com' | 'https://thumbtack.com'

/**
 * API and OAuth hosts per widget environment — confirmed from Thumbtack's
 * Environments doc. Keyed off the SAME widget-host value THUMBTACK_ENVIRONMENT
 * already stores, rather than a second independent env var, since the two can
 * never legitimately disagree: their own doc states production requests
 * return thumbtack.com links and staging requests return staging-partner
 * ones, so using production API credentials with the staging widget host (or
 * vice versa) is itself a bug, not a valid configuration.
 */
const THUMBTACK_ENVIRONMENTS: Readonly<Record<ThumbtackEnvironment, { apiBase: string; authBase: string }>> = {
  'https://thumbtack.com': {
    apiBase:  'https://api.thumbtack.com/api',
    authBase: 'https://auth.thumbtack.com',
  },
  'https://staging-partner.thumbtack.com': {
    apiBase:  'https://staging-api.thumbtack.com/api',
    authBase: 'https://staging-auth.thumbtack.com',
  },
}

function resolveThumbtackEnvironment(): { widgetHost: ThumbtackEnvironment; apiBase: string; authBase: string } {
  const widgetHost = process.env.THUMBTACK_ENVIRONMENT
  const config = THUMBTACK_ENVIRONMENTS[widgetHost as ThumbtackEnvironment]
  if (!config) {
    throw new Error(
      `THUMBTACK_ENVIRONMENT is not set to a recognized Thumbtack environment ` +
      `(got "${widgetHost}", expected one of ${Object.keys(THUMBTACK_ENVIRONMENTS).join(' or ')}).`
    )
  }
  return { widgetHost: widgetHost as ThumbtackEnvironment, ...config }
}

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

/**
 * Hiring signals Thumbtack surfaces per pro — confirmed from their Discovery
 * Lite design-guidelines deck. Exactly these four values, no others.
 */
export type ThumbtackProPill = 'popular' | 'remote' | 'licensed' | 'low_price'

/**
 * A pro returned by a Thumbtack search. Confirmed 2026-09 against Discovery
 * Lite's own sample API response (their design-guidelines deck, "API
 * Response" slide) for every field except `requestFlowUrl` — Discovery
 * Lite's response has NO request-flow URL or any other link field at all,
 * only `service_id`. That's consistent with the original Request Flow
 * Widget doc's `/businesses/search` (a DIFFERENT, richer endpoint) already
 * returning a ready-made `widgets.requestFlowURL` per pro — the working
 * theory is Discovery Lite is read-only display data, and a CTA click needs
 * buildRequestFlowUrl() to construct the URL from `servicePk` (their
 * `service_id`) plus the category_pk this search already used. Until the
 * real endpoint is confirmed, `requestFlowUrl` stays nullable so a caller
 * can't assume it's always pre-built.
 *
 * Two more open questions this schema does NOT answer, so don't build
 * against them without checking first:
 *   - No avatar/photo URL field exists anywhere in the confirmed response.
 *     The design mock shows one ("Pro avatar: Profile image URL field"),
 *     so it likely exists on the real payload — just not in this
 *     abbreviated example.
 *   - `quote.starting_cost` has no confirmed unit. Treated here as CENTS
 *     (this codebase's convention everywhere else money is stored), but the
 *     design mock renders it as "$59/hr" — a raw 15000 read as cents is
 *     $150.00, which is a much more plausible "starting cost" for a repair
 *     job than $15,000 read as dollars, but this is inference, not
 *     confirmation.
 */
export interface ThumbtackPro {
  /** Their `service_id` — the one identifier Discovery Lite's response actually has; doubles as `service_pk` for buildRequestFlowUrl(). */
  servicePk:          string
  businessName:       string
  /** Null until the real search implementation confirms whether this comes pre-built or needs buildRequestFlowUrl(). */
  requestFlowUrl:     string | null
  rating?:            number
  numReviews?:        number
  yearsInBusiness?:   number
  numHires?:          number
  similarJobsDone?:   number
  numEmployees?:      number
  licenseVerified?:   boolean
  hasBackgroundCheck?: boolean
  location?:          string
  pills?:             ThumbtackProPill[]
  /** See the interface note above re: unit — treated as cents. */
  startingCostCents?: number
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

/** True once all four THUMBTACK_* env vars are set — see lib/env.ts. */
export function isThumbtackConfigured(): boolean {
  return Boolean(
    process.env.THUMBTACK_ENVIRONMENT &&
    process.env.THUMBTACK_CLIENT_ID &&
    process.env.THUMBTACK_CLIENT_SECRET &&
    process.env.THUMBTACK_UTM_SOURCE
  )
}

interface ThumbtackTokenResponse {
  access_token: string
  expires_in:   number
}

/**
 * In-memory only — fine for a single Vercel function instance's lifetime,
 * and this module already has no other persistent state. A cold start just
 * means the next call re-fetches, which is cheap and correct; there is no
 * multi-instance consistency requirement here the way there would be for,
 * say, a rate limit budget.
 *
 * Keyed by `authBase` (not a single bare value) so a cached production token
 * can never be served for a staging call or vice versa. THUMBTACK_ENVIRONMENT
 * is a fixed per-deployment value in real use, so this never matters in
 * production — but it's a real gap otherwise (nothing about a bare cache
 * variable would stop it), not just a testing convenience.
 */
const cachedTokensByAuthBase = new Map<string, { accessToken: string; expiresAtMs: number }>()

/**
 * Extracts a human-readable message from a Thumbtack error response body.
 * Their Troubleshooting doc documents three different shapes across
 * different failure modes — `{ error, error_description }` (invalid_client),
 * `{ type, title, status, detail }` (token is not active), and
 * `{ error, detail }` (proxy_oauth_failed) — so this checks all of the
 * fields any of them use rather than assuming one shape.
 */
async function readThumbtackErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json() as Record<string, unknown>
    const detail = body.error_description ?? body.detail ?? body.title ?? body.error
    return typeof detail === 'string' ? detail : JSON.stringify(body)
  } catch {
    return res.statusText || 'no error body'
  }
}

/**
 * Forces the next getThumbtackAccessToken() call for this authBase to fetch
 * a fresh token instead of serving a cached one. For the retry-once-on-401
 * pattern Thumbtack's Troubleshooting doc calls for ("token is not active" —
 * their access tokens expire and a client must handle refreshing): the
 * eventual /businesses/search implementation should call this on a 401, then
 * retry the request once with a freshly fetched token, rather than trusting
 * this module's own expiry estimate never drifts from Thumbtack's actual
 * clock. Exported now, ahead of that implementation, the same way
 * buildRequestFlowUrl() and this file's other pieces are — not yet called
 * from within this module, but real infrastructure the next piece needs.
 */
export function invalidateThumbtackToken(authBase: string): void {
  cachedTokensByAuthBase.delete(authBase)
}

/**
 * OAuth2 client_credentials token exchange — confirmed shape from
 * Thumbtack's Environments doc (Authorization Server, Token URL,
 * per-environment clientID/clientSecret). Cached in memory and refreshed
 * 30s before actual expiry, so a normal request never pays for a token
 * fetch on top of the search call it's making the token for.
 *
 * THUMBTACK_AUDIENCE is optional and omitted from the request unless set —
 * their Troubleshooting doc's proxy_oauth_failed entry ("Requested audience
 * '<your audience>' has not been whitelisted") implies an `audience` param
 * is expected by at least some Thumbtack partner configurations, but names
 * no default value. Guessing one (e.g. the API base URL) risks causing
 * exactly that error rather than avoiding it, so this stays opt-in until a
 * Thumbtack rep confirms the right value for this account.
 *
 * Not exported — searchThumbtackPros() is the only caller. Exported (rather
 * than module-private) would invite a second call site to acquire its own
 * token and its own cache, defeating the point of caching at all.
 */
async function getThumbtackAccessToken(): Promise<string> {
  const { authBase } = resolveThumbtackEnvironment()

  const cached = cachedTokensByAuthBase.get(authBase)
  if (cached && cached.expiresAtMs > Date.now() + 30_000) {
    return cached.accessToken
  }

  const clientId     = process.env.THUMBTACK_CLIENT_ID
  const clientSecret = process.env.THUMBTACK_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('THUMBTACK_CLIENT_ID/THUMBTACK_CLIENT_SECRET are not set — see lib/env.ts.')
  }

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  })
  if (process.env.THUMBTACK_AUDIENCE) params.set('audience', process.env.THUMBTACK_AUDIENCE)

  let res: Response
  try {
    res = await fetch(`${authBase}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params,
      signal:  AbortSignal.timeout(THUMBTACK_TIMEOUT_MS),
    })
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`Thumbtack OAuth token request to ${authBase} timed out after ${THUMBTACK_TIMEOUT_MS}ms`)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Thumbtack OAuth token request to ${authBase} failed: ${message}`)
  }

  if (!res.ok) {
    const detail = await readThumbtackErrorDetail(res)
    throw new Error(`Thumbtack OAuth token request failed with ${res.status}: ${detail}`)
  }

  const data = await res.json() as ThumbtackTokenResponse
  const token = { accessToken: data.access_token, expiresAtMs: Date.now() + data.expires_in * 1000 }
  cachedTokensByAuthBase.set(authBase, token)
  return token.accessToken
}

/**
 * PARTIALLY IMPLEMENTED — see the module header. The OAuth token fetch is
 * real; the actual /businesses/search request past it still throws, because
 * its path, query params, and response schema aren't confirmed. Failing
 * loudly here (rather than returning an empty list) means a call site sees
 * "this isn't built yet" instead of a result that reads as "no pros nearby."
 *
 * When implementing: if the real response has no ready-made request-flow
 * URL (Discovery Lite's confirmed shape doesn't), build one per pro with
 * buildRequestFlowUrl() using this function's own resolved category_pk and
 * that pro's service_id as servicePk, rather than leaving requestFlowUrl
 * null and pushing that work onto every caller.
 */
export async function searchThumbtackPros(_params: {
  categoryKey: ThumbtackCategoryKey
  zipCode:     string | null
}): Promise<ThumbtackPro[]> {
  const { apiBase } = resolveThumbtackEnvironment()
  await getThumbtackAccessToken()

  throw new Error(
    `Thumbtack /businesses/search is not yet implemented against ${apiBase} — the exact ` +
    'path, query params, and response schema need confirming with a Thumbtack rep first. ' +
    'See lib/integrations/thumbtack.ts.'
  )
}
