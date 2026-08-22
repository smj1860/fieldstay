// src/lib/integrations/providers/ownerrez.ts
// ============================================================
// OwnerRez OAuth 2.0 provider adapter.
// Implements RFC 6749 Section 4.1 (Authorization Code Grant).
//
// OwnerRez specifics:
//   - Token exchange uses HTTP Basic Auth (NOT Bearer)
//   - Tokens are long-lived; there are NO refresh tokens
//   - Every API call must include a specific User-Agent header
//   - Webhook auth is HTTP Basic Auth (credentials you define)
//   - Revocation webhook body uses "action", not "event_type"
// ============================================================

import { tryUnwrap } from '@/lib/supabase/unwrap'
import type {
  IntegrationProvider,
  TokenResponse,
  OwnerRezProperty,
  OwnerRezListing,
  OwnerRezListingAmenityCategory,
  OwnerRezBooking,
} from '../types'
import { IntegrationMisconfiguredError } from '../types'
import type { NormalizedBooking } from '@/lib/bookings/normalize'
import { unmappedBookingStatus } from '@/lib/bookings/normalize'
import type { Enums, TablesUpdate } from '@/types/database'
import { parseCidrAllowlist, validateBasicAuthWebhook } from '../webhook-verification'
import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'
import { SYNCABLE_CONNECTION_STATUSES } from '@/lib/integrations/connection-metadata'

// ── OwnerRez webhook source-IP allowlist (audit 2026-07-30, L-4) ────────────
//
// ACCEPTED RISK, EXPLICITLY. OwnerRez authenticates its webhooks with HTTP
// Basic Auth, which carries no timestamp and no nonce, so — unlike Telnyx
// (Ed25519 over `timestamp|body`) and Stripe (constructEvent's own tolerance
// window) — nothing in the request itself expires. Replay protection is
// therefore ENTIRELY the processed_webhooks content hash in
// app/api/webhooks/[provider]/route.ts, and that table is pruned on a TTL by
// lib/inngest/functions/cron/webhook-dedup-cleanup.ts. A captured request
// replays successfully once its dedup row has aged out.
//
// Hospitable closes the equivalent gap with a published IP range
// (HOSPITABLE_WEBHOOK_IP_CIDR, 38.80.170.0/24). OwnerRez publishes no
// egress ranges for webhook delivery — nothing in their webhooks
// documentation or developer portal commits to a set of source addresses, so
// there is no constant to hardcode here and inventing one would break
// deliveries the first time they moved infrastructure.
//
// What we do instead: honour an OPERATOR-SUPPLIED allowlist. Set
// OWNERREZ_WEBHOOK_IP_CIDRS to a comma-separated list of CIDRs (e.g.
// "1.2.3.0/24,5.6.7.8/32") once the real ranges are confirmed with OwnerRez
// support, and this check engages with no code change. Unset (the default),
// the check is skipped and the residual risk above stands: an attacker who
// captured a valid delivery can replay it after the dedup TTL. That is
// bounded by what an OwnerRez webhook can actually do — it carries no
// authority of its own, it only tells us an entity changed, and every
// downstream handler re-reads the entity from OwnerRez's API before acting.
function ownerrezAllowedCidrs(): string[] {
  return parseCidrAllowlist(process.env.OWNERREZ_WEBHOOK_IP_CIDRS)
}

// ── Constants ────────────────────────────────────────────────────────────────

const OWNERREZ_AUTHORIZE_URL = 'https://app.ownerrez.com/oauth/authorize'
const OWNERREZ_TOKEN_URL     = 'https://api.ownerrez.com/oauth/access_token'
const OWNERREZ_API_BASE      = 'https://api.ownerrez.com'
const APP_VERSION            = '1.0'

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Base64-encodes "clientId:clientSecret" for HTTP Basic Auth.
 * Used for token exchange AND for revoking tokens.
 */
function buildBasicAuth(): string {
  const clientId     = process.env.OWNERREZ_CLIENT_ID
  const clientSecret = process.env.OWNERREZ_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new IntegrationMisconfiguredError(
      'Missing OWNERREZ_CLIENT_ID or OWNERREZ_CLIENT_SECRET environment variables'
    )
  }

  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

/**
 * The required User-Agent header for all OwnerRez API calls.
 * Format: "AppName/Version (ClientId)"
 * Failure to send this causes 403 errors from OwnerRez.
 */
function buildUserAgent(): string {
  const clientId = process.env.OWNERREZ_CLIENT_ID ?? 'unknown'
  return `FieldStay/${APP_VERSION} (${clientId})`
}

// ── Provider adapter ─────────────────────────────────────────────────────────

/**
 * Resolves which FieldStay connection an OwnerRez webhook belongs to, so
 * ownerrez-incremental-sync.ts can scope its work to that one connection
 * instead of re-syncing every active OwnerRez tenant platform-wide.
 *
 * Degrades rather than throwing: an unresolved connection deliberately falls
 * back to the full platform sweep (see events.ts), so the webhook is still
 * handled — but tryUnwrap records WHY the scoped path was skipped instead of
 * silently widening it.
 */
async function resolveOwnerRezWebhookConnection(
  externalUserId: string | null | undefined,
): Promise<{ user_id: string; org_id: string } | null> {
  if (!externalUserId) return null

  const { createServiceClient } = await import('@/lib/supabase/server')
  const supabase = createServiceClient({ system: 'lib/integrations/providers/ownerrez' })

  const connRes = await supabase
    .from('integration_connections')
    .select('user_id, org_id')
    .eq('provider_id', 'ownerrez')
    .eq('external_user_id', externalUserId)
    // Includes 'error'. An errored connection is precisely the one a webhook
    // should be allowed to wake: narrowing to 'active' sent it to the full
    // platform sweep instead, which until 2026-08-18 skipped it for the same
    // reason. See SYNCABLE_CONNECTION_STATUSES.
    .in('status', [...SYNCABLE_CONNECTION_STATUSES])
    .maybeSingle()

  const connOut = tryUnwrap(connRes, { site: 'lib.integrations.ownerrez.webhook-scope' })
  const conn    = connOut.ok ? connOut.data : null

  return conn?.org_id ? { user_id: conn.user_id, org_id: conn.org_id } : null
}

export const ownerRezProvider: IntegrationProvider = {
  id:          'ownerrez',
  displayName: 'OwnerRez',
  authType:    'oauth2',

  // Step 1: Build the URL the user is redirected to on OwnerRez
  getAuthorizationUrl({ state, redirectUri }) {
    const url = new URL(OWNERREZ_AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id',     process.env.OWNERREZ_CLIENT_ID!)
    url.searchParams.set('redirect_uri',  redirectUri)
    url.searchParams.set('state',         state)
    return url.toString()
  },

  // Step 3: Exchange the temporary code for a long-lived access token
  async exchangeCodeForToken({ code, redirectUri }) {
    const response = await fetch(OWNERREZ_TOKEN_URL, {
      signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${buildBasicAuth()}`,
        'User-Agent':    buildUserAgent(),
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,     // must match exactly what was sent in step 1
      }),
    })

    if (!response.ok) {
      let errorDetail = `HTTP ${response.status}`
      try {
        const body = await response.json() as { error?: string; error_description?: string }
        errorDetail = body.error_description ?? body.error ?? errorDetail
      } catch {
        // ignore JSON parse failure
      }
      throw new Error(`OwnerRez token exchange failed: ${errorDetail}`)
    }

    const data = await response.json() as {
      access_token: string
      token_type:   string
      scope:        string
      user_id:      number
    }

    return {
      accessToken:     data.access_token,
      externalUserId:  String(data.user_id),  // OwnerRez user_id as string
      scope:           data.scope,
    } satisfies TokenResponse
  },

  // NOTE: OwnerRez has NO refresh tokens. Tokens never expire unless revoked.
  // refreshAccessToken is intentionally NOT implemented.

  // Called when a FieldStay user disconnects OwnerRez from within our UI
  async revokeAccessToken({ token }) {
    const response = await fetch(`${OWNERREZ_API_BASE}/oauth/access_token/${token}`, {
      signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
      method:  'DELETE',
      headers: {
        'Authorization': `Basic ${buildBasicAuth()}`,
        'User-Agent':    buildUserAgent(),
      },
    })

    // 404 means the token was already invalid — treat as success
    if (!response.ok && response.status !== 404) {
      throw new Error(`OwnerRez token revocation failed: HTTP ${response.status}`)
    }
  },

  // Returns the headers needed for all OwnerRez API v2 calls
  getApiHeaders(token: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${token}`,
      'User-Agent':    buildUserAgent(),
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    }
  },

  // Validates incoming webhook requests from OwnerRez using HTTP Basic Auth.
  // Credentials (user + password) are ones YOU defined in the app registration.
  // Basic Auth has no timestamp concept, so replay protection for OwnerRez
  // webhooks comes from the processed_webhooks dedup table plus — when
  // configured — the optional source-IP allowlist above. See the
  // ownerrezAllowedCidrs() comment for the accepted residual risk.
  async validateWebhook(request: Request) {
    // Basic Auth with credentials WE chose at registration, plus an optional
    // source-IP allowlist. The implementation is shared with Hostaway, which
    // registers webhooks the same way — see validateBasicAuthWebhook for the
    // first-colon and constant-time rules it carries.
    return validateBasicAuthWebhook({
      request,
      expectedUser: process.env.OWNERREZ_WEBHOOK_USER,
      expectedPass: process.env.OWNERREZ_WEBHOOK_PASSWORD,
      allowedCidrs: ownerrezAllowedCidrs(),
      envPrefix:    'OWNERREZ_WEBHOOK',
    })
  },

  // Handles OwnerRez-specific webhook events beyond the generic revocation.
  // ⚠️ OwnerRez's own webhooks doc is internally inconsistent about the
  // create-action name: the "Actions" reference table on that page lists
  // entity_create, but the "Keeping track of blocks/bookings over time"
  // section further down the SAME page says to listen for entity_insert.
  // Handling both costs nothing — neither string means anything else — so
  // this doesn't pick a side. entity_update/entity_delete are consistent
  // across both sections. See app-api-webhooks doc, 2026-07-16.
  async handleWebhookEvent({ action, payload, externalUserId, correlationId }) {
    const data       = payload as Record<string, unknown>
    const entityType = String(data.entity_type ?? '')
    const entityId   = String(data.entity_id ?? '')

    switch (action) {
      case 'application_authorization_revoked':
        // Handled by the generic webhook route — nothing to do here
        break

      case 'webhook_test':
        // OwnerRez's own connectivity check when the webhook URL is saved
        // in the Developer/API settings — no sync action needed, just
        // acknowledge with a 2xx (the route handler already does this for
        // any case that doesn't throw).
        break

      case 'entity_insert':
      case 'entity_create':
      case 'entity_update':
      case 'entity_delete': {
        // Property CREATION webhooks ride the same scoped-sync path as
        // booking/guest changes: the incremental-sync dispatcher always sets
        // check_new_properties=true on scoped runs, so the per-connection
        // handler's getProperties() diff discovers the new property and
        // re-fires initial sync for it. This webhook is the PRIMARY
        // new-property discovery path — the hourly cron only re-checks once
        // a day as a missed-webhook backstop. Property entity_update/delete
        // still have no handler (nothing to do — edits don't create work).
        const isNewProperty =
          entityType === 'property' &&
          (action === 'entity_insert' || action === 'entity_create')

        if (entityType === 'booking' || entityType === 'guest' || isNewProperty) {
          // Resolve which FieldStay connection this webhook belongs to, so
          // ownerrez-incremental-sync.ts can scope its work to just this one
          // connection instead of re-syncing every active OwnerRez tenant
          // platform-wide. Falls back to unresolved (fields simply omitted)
          // if the lookup misses — the sync function then falls back to its
          // full-sweep behavior, same as before this resolution existed.
          const connection = await resolveOwnerRezWebhookConnection(externalUserId)

          const { inngest } = await import('@/lib/inngest/client')
          await inngest.send({
            name: 'integration/ownerrez.sync.requested',
            data: {
              provider_id:    'ownerrez',
              event_type:     action,
              entity_type:    entityType,
              entity_id:      entityId,
              triggered_at:   new Date().toISOString(),
              correlation_id: correlationId ?? null,
              user_id:        connection?.user_id,
              org_id:         connection?.org_id,
            },
          })
        } else {
          // property (update/delete only — creation is handled above),
          // inquiry, quote, thread_message — OwnerRez's real supported
          // entity_type list (confirmed live 2026-07-16), none wired to a
          // specific handler yet. Note: 'review' is NOT a valid
          // OwnerRez webhook entity_type at all — reviews can only be
          // synced via the existing 6-hour polling cron
          // (ownerrez-reviews-sync.ts), there is no webhook alternative.
          // Distinct from an unrecognized action: known entity type, no handler yet.
          console.log(`[OwnerRez] entity_type "${entityType}" webhook received, no specific handler yet (action=${action})`)
        }
        break
      }

      default: {
        const safeLog = { action, entity_id: entityId || null }
        console.warn('[OwnerRez] Unhandled webhook action', safeLog)
      }
    }
  },
}

// ── Data mapping helpers ─────────────────────────────────────────────────────
// Previously duplicated verbatim in ownerrez/initial-sync.ts and
// ownerrez/incremental-sync.ts — consolidated here as the single source of
// truth, mirroring where Hospitable's equivalent mappers live.

/**
 * OwnerRez booking status -> our enum.
 *
 * THE DOCUMENTED VALUES ARE `active` | `canceled` | `pending`. Nothing else.
 * Verified 2026-08-21 against api.ownerrez.com/help/v2/bookings/get-bookings.
 *
 * This mapper previously matched `'confirmed'` and `'tentative'` — two strings
 * OwnerRez has never sent — so every live reservation fell through to
 * unmappedBookingStatus() and was written as `tentative`. Production held 28
 * OwnerRez bookings and ZERO confirmed ones, while Hospitable in the same
 * table mapped normally; `canceled` was the only value that ever matched,
 * which is why 2 of 30 looked right.
 *
 * What that cost, measured rather than assumed:
 *   - Owner ledgers. Revenue posts behind `status === 'confirmed'` (line ~644
 *     here, and reservation-pipeline.ts). 5 of 28 OwnerRez bookings carrying a
 *     dollar amount had posted revenue; Hospitable was 10 of 10.
 *   - Guest messaging. guidebook-pre-arrival-email-cron and
 *     guidebook-stay-extension-cron both filter .eq('status','confirmed') —
 *     no pre-arrival email, no gap-night offer, ever.
 *   - Double-booking detection (ical/conflict-detection.ts) and the par
 *     learning engine (inventory/record-consumption.ts) skip them too.
 *
 * Turnovers were NOT affected: lib/turnovers/generator.ts accepts
 * ['confirmed','tentative'], which is why the integration looked healthy —
 * cleans were scheduled, so the visible surface worked while the ledger and
 * every guest-facing automation silently did nothing.
 *
 * `pending` -> 'tentative' is deliberate and is the one case the old default
 * happened to get right: a pending OwnerRez booking is genuinely not confirmed.
 */
export function mapOwnerRezBookingStatus(status: string): Enums<'booking_status'> {
  const s = status.toLowerCase()
  // The real OwnerRez vocabulary.
  if (s === 'active')  return 'confirmed'
  if (s === 'pending') return 'tentative'
  if (s === 'canceled' || s === 'cancelled') return 'cancelled'
  // Kept as tolerated aliases, not as the contract: they cost nothing, and a
  // provider that starts sending the obvious word should not regress to
  // tentative while someone reads this file.
  if (s === 'confirmed') return 'confirmed'
  if (s === 'tentative') return 'tentative'
  return unmappedBookingStatus('ownerrez', status)
}

/**
 * OwnerRez `listing_site` -> our booking_source enum.
 *
 * READS `listing_site`. The caller previously passed `b.channel_name`, which
 * is not a field on OwnerRez's booking schema and never has been — so this
 * received `undefined` for every booking and returned the no-channel default.
 * All 30 OwnerRez bookings in production carry source 'other'; Hospitable, in
 * the same table, spreads across direct/airbnb. Same defect class as the
 * status mapper above: a field name the provider never sends, and a fallback
 * plausible enough that the result looks like data rather than a miss.
 *
 * Substring matching rather than equality because `listing_site` is
 * undocumented as an enum — OwnerRez publishes the field with no value list,
 * so matching loosely on the recognisable brand is the honest read. Anything
 * unrecognised stays 'other', which for a SOURCE label is a fair outcome
 * rather than a silent degradation: unlike status, no downstream automation
 * branches on it.
 */
export function mapOwnerRezChannelToSource(listingSite?: string): Enums<'booking_source'> {
  if (!listingSite) return 'other'
  const c = listingSite.toLowerCase()
  if (c.includes('airbnb')) return 'airbnb'
  if (c.includes('vrbo') || c.includes('homeaway')) return 'vrbo'
  if (c.includes('booking')) return 'booking_com'
  if (c.includes('direct')) return 'direct'
  return 'other'
}

// Actual structure is amenity_categories with nested amenities[].title —
// not a flat array with an amenity_id field.
export function normalizeOwnerRezAmenities(
  categories: OwnerRezListingAmenityCategory[]
): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const category of categories ?? []) {
    for (const amenity of category.amenities ?? []) {
      if (!amenity.title) continue
      const key = amenity.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
      result[key] = true // presence in the list = amenity exists at the property
    }
  }
  return result
}

type OwnerRezDetailPatchExisting = {
  wifi_name:           string | null
  wifi_password:       string | null
  access_instructions: string | null
  house_manual:        string | null
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

function patchAddressFields(patch: TablesUpdate<'properties'>, addr: OwnerRezProperty['address']): void {
  if (!addr) return
  if (addr.street1)     patch.address = addr.street1
  if (addr.state)       patch.state   = addr.state
  if (addr.city)        patch.city    = addr.city
  if (addr.postal_code) patch.zip     = addr.postal_code
}

// Several detail fields used truthy checks (`if (detail.latitude)`) before
// this was extracted, meaning a legitimate value of exactly 0 (or, for
// min_renter_age, an explicit null clearing a prior value) would be silently
// skipped. Low real-world likelihood (no real US property sits on the
// equator or requires a minimum renter age of 0), but corrected for
// consistency with the rest of the codebase's null-handling convention.
function patchDetailScalarFields(patch: TablesUpdate<'properties'>, detail: OwnerRezProperty): void {
  if (isPresent(detail.latitude))        patch.lat            = detail.latitude
  if (isPresent(detail.longitude))       patch.lng            = detail.longitude
  if (isPresent(detail.max_guests))      patch.max_guests      = detail.max_guests
  if (isPresent(detail.smoking_allowed)) patch.smoking_allowed = detail.smoking_allowed
  if (isPresent(detail.pets_allowed))    patch.pets_allowed    = detail.pets_allowed
  if (isPresent(detail.max_pets))        patch.max_pets        = detail.max_pets
  if (isPresent(detail.events_allowed))  patch.events_allowed  = detail.events_allowed
  if (isPresent(detail.min_renter_age))  patch.min_renter_age  = detail.min_renter_age
}

function patchListingContentFields(
  patch:    TablesUpdate<'properties'>,
  existing: OwnerRezDetailPatchExisting,
  listing:  OwnerRezListing
): void {
  if (!existing.wifi_name && listing.wifi_network)
    patch.wifi_name = listing.wifi_network

  if (!existing.wifi_password && listing.wifi_password)
    patch.wifi_password = listing.wifi_password

  if (!existing.access_instructions && listing.check_in_instructions)
    patch.access_instructions = listing.check_in_instructions

  if (!existing.house_manual && listing.house_manual)
    patch.house_manual = listing.house_manual

  if (listing.amenity_categories?.length) {
    patch.amenities = normalizeOwnerRezAmenities(listing.amenity_categories)
  }
}

/**
 * Builds the DB patch for a property's enrichment pass (address, lat/lng,
 * occupancy/rules from the detail endpoint; WiFi/instructions/house
 * manual/amenities from the listings endpoint — WiFi and instructions are
 * fill-only-if-null against `existing`, matching FieldStay's Hospitable
 * mapper policy; everything else always overwrites). Pure function — no
 * I/O — extracted from the per-property enrichment step in
 * ownerrez/initial-sync.ts for direct unit test coverage.
 */
export function buildOwnerRezDetailPatch(
  existing: OwnerRezDetailPatchExisting,
  detail:  OwnerRezProperty | null,
  listing: OwnerRezListing | undefined
): TablesUpdate<'properties'> {
  const patch: TablesUpdate<'properties'> = {}

  if (detail) {
    patchAddressFields(patch, detail.address)
    patchDetailScalarFields(patch, detail)
  }

  if (listing) {
    patchListingContentFields(patch, existing, listing)
  }

  return patch
}

// ✅ Confirmed live 2026-07-15 — GET /v2/bookings/{id} returns charges[],
// each carrying owner_amount (what's owed to the property owner, net of
// any PM commission) alongside amount (the gross charge). Summing
// owner_amount across every charge line item is the direct read of "total
// owed to the owner" the field is named for; total_amount/total_owed
// (equal to each other and to the owner_amount sum on every sampled
// booking, all commission-free) are the fallback when charges is absent.
// Mirrors extractHospitableActualTotal's "prefer the PMS's own owner-side
// figure over a guest-paid total" preference.
function extractOwnerRezActualTotal(b: OwnerRezBooking): number | null {
  if (b.charges?.length) {
    const sum = b.charges.reduce((total, charge) => total + (charge.owner_amount ?? charge.amount), 0)
    if (Number.isFinite(sum) && sum > 0) return sum
  }

  const total = b.total_amount ?? b.total_owed
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) return total

  return null
}

/**
 * Pure raw -> NormalizedBooking mapper for an OwnerRez booking. Extracted
 * from the previously-duplicated inline row-building logic in
 * ownerrez/initial-sync.ts and ownerrez/incremental-sync.ts — consolidated
 * here as the single source of truth, mirroring
 * hospitableReservationToNormalized.
 *
 * IT DOES RETURN TIMES OF DAY. This comment used to claim the opposite —
 * "OwnerRez's booking endpoint doesn't return a time-of-day for
 * arrival/departure (unlike Hospitable's check_in/check_out)" — and hardcoded
 * both to null on that basis. OwnerRez's booking schema documents `check_in`
 * and `check_out` as 24-hour "HH:mm" strings in the PROPERTY's timezone,
 * alongside the `arrival`/`departure` dates. Verified 2026-08-21.
 *
 * The cost was every OwnerRez turnover. lib/turnovers/generator.ts falls back
 * to '11:00'/'15:00' when a booking carries no time and the property has no
 * default, so cleaning windows were computed from an assumption rather than
 * the real checkout — and on a same-day flip that assumption is the whole
 * schedule. Production: 0 of 30 OwnerRez bookings had either time; Hospitable
 * had 11 of 12.
 */
export function ownerRezBookingToNormalized(b: OwnerRezBooking): NormalizedBooking {
  // block/quote_hold/linked_availability are all "time marked unavailable,
  // no guest" in OwnerRez's own booking-type taxonomy — treat all three as
  // a block. This reconciles two previously-disconnected signals:
  // is_block (checked by turnover generation, guidebook emails, owner
  // portal) and status: 'blocked' (the only signal the bookings UI
  // actually renders "Blocked / Unavailable" from) — both must agree on
  // every block-family booking. A legacy/future `type` value combined
  // with a true `is_block` flag from OwnerRez must still count as a
  // block: both signals are OR'd into one `isBlock` value and every field
  // below derives from that same value, so status and is_block can never
  // disagree.
  const isBlockType = b.type === 'block' || b.type === 'quote_hold' || b.type === 'linked_availability'
  const isBlock      = isBlockType || (b.is_block ?? false)

  return {
    external_id: String(b.id),
    property_external_id: b.property_id !== null && b.property_id !== undefined
      ? String(b.property_id)
      : null,
    checkin_date:  b.arrival,
    checkout_date: b.departure,
    // Normalized to null when OwnerRez omits them, so the row builder can tell
    // "no value" from "a value" and omit the column rather than clobber.
    checkin_time:  b.check_in  ?? null,
    checkout_time: b.check_out ?? null,
    status:      isBlock ? 'blocked' : mapOwnerRezBookingStatus(b.status),
    // ✅ Confirmed live 2026-07-15 — OwnerRez's guest object has
    // first_name/last_name, not a combined name field (see OwnerRezBooking.guest
    // doc comment). No email field was ever present on this endpoint.
    guest_name:  [b.guest?.first_name, b.guest?.last_name].filter(Boolean).join(' ') || null,
    guest_email: null,
    source:      mapOwnerRezChannelToSource(b.listing_site),
    is_block:    isBlock,
    // Effective 2026-07-07, OwnerRez's type field can be 'owner' — the
    // property owner's own personal-use stay. It's a full booking (not a
    // block; is_block is false), so it flows through the same upsert path
    // as a guest booking and still gets a turnover — just tagged.
    stay_type:   b.type === 'owner' ? 'owner_stay' : 'guest_stay',
    actual_total_amount: extractOwnerRezActualTotal(b),
  }
}

export interface OwnerRezBookingRow {
  org_id:              string
  property_id:         string | null
  external_source:     'ownerrez'
  external_id:         string
  checkin_date:        string
  checkout_date:       string
  /**
   * OPTIONAL on purpose — see buildOwnerRezBookingRow. Present only when
   * OwnerRez sent a time; absent (not null) otherwise, so the upsert leaves a
   * PM's manual edit alone instead of overwriting it every sync.
   */
  checkin_time?:       string
  checkout_time?:      string
  status:              Enums<'booking_status'>
  guest_name:          string | null
  guest_email:         string | null
  source:              Enums<'booking_source'>
  is_block:            boolean
  stay_type:           string
  actual_total_amount: number | null
}

/**
 * Builds one `bookings` upsert row from a raw OwnerRez booking, resolving
 * property_id through the externalToFsId map each sync builds from its own
 * property lookup step. Consolidates row-building logic previously
 * duplicated verbatim in ownerrez/initial-sync.ts and
 * ownerrez/incremental-sync.ts.
 *
 * checkin_time/checkout_time are set WHEN OWNERREZ SENDS THEM and omitted
 * entirely when it does not. Both halves matter:
 *
 *   - Sent. OwnerRez does provide times (`check_in`/`check_out`, "HH:mm" in
 *     the property's timezone); the previous claim that it "never provides a
 *     time-of-day" was wrong, and it cost every OwnerRez turnover its real
 *     cleaning window — see ownerRezBookingToNormalized above.
 *   - Absent. The keys are OMITTED, not written as null. That part of the old
 *     reasoning was right and is preserved: a null on every sync would clobber
 *     a PM's manual edit (see app/(dashboard)/bookings/actions.ts), and an
 *     omitted key is left untouched on conflict. `undefined` would also work —
 *     JSON drops it — but omitting is explicit about the intent.
 */
export function buildOwnerRezBookingRow(
  orgId:          string,
  b:              OwnerRezBooking,
  externalToFsId: Record<string, string>
): OwnerRezBookingRow {
  const normalized = ownerRezBookingToNormalized(b)
  return {
    org_id: orgId,
    property_id: normalized.property_external_id
      ? (externalToFsId[normalized.property_external_id] ?? null)
      : null,
    external_source:     'ownerrez',
    external_id:         normalized.external_id,
    // b.arrival/b.departure used directly so these stay typed as
    // non-nullable strings — OwnerRez always has both, unlike Hospitable
    // where the normalized fields can be null.
    checkin_date:        b.arrival,
    checkout_date:       b.departure,
    // Spread-in rather than assigned, so an absent time contributes NO KEY at
    // all. `checkin_time: normalized.checkin_time` would write null and undo
    // a PM's manual edit on every sync.
    ...(normalized.checkin_time  !== null && { checkin_time:  normalized.checkin_time  }),
    ...(normalized.checkout_time !== null && { checkout_time: normalized.checkout_time }),
    status:              normalized.status,
    guest_name:          normalized.guest_name,
    guest_email:         normalized.guest_email,
    source:              normalized.source,
    is_block:            normalized.is_block,
    stay_type:           normalized.stay_type,
    actual_total_amount: normalized.actual_total_amount,
  }
}

/**
 * What a batch of OwnerRez bookings says about `cleaning_date`.
 *
 * A PROBE, not a feature. Nothing consumes cleaning_date — see the field's
 * note on OwnerRezBooking for why adopting it is a model change rather than a
 * mapping — and this exists so that decision is made against data instead of
 * against a guess about how OwnerRez customers use their housekeeping feature.
 *
 * Pure, so it is testable without driving a sync, and so it cannot fail one.
 *
 * `derivedFromCheckout` is the question that would make the whole idea moot:
 * if OwnerRez simply stamps the departure date, the field carries no
 * information the generator does not already have from checkout_date. Compared
 * on the DATE part only — a cleaning date of "2026-08-10T10:00:00" against a
 * departure of "2026-08-10" is the derived case even though the timestamps
 * differ, and the time-of-day is exactly what would be new if it varied.
 */
export interface OwnerRezCleaningDateProbe {
  /** Bookings examined in this batch. */
  total:               number
  /** How many carried a non-empty cleaning_date. */
  withCleaningDate:    number
  /** Of those, how many fall on the booking's own departure date. */
  derivedFromCheckout: number
  /** Of those, how many carry a time-of-day other than midnight. */
  withTimeOfDay:       number
}

export function summarizeOwnerRezCleaningDates(
  bookings: readonly OwnerRezBooking[],
): OwnerRezCleaningDateProbe {
  const probe: OwnerRezCleaningDateProbe = {
    total: bookings.length, withCleaningDate: 0, derivedFromCheckout: 0, withTimeOfDay: 0,
  }

  for (const b of bookings) {
    const raw = b.cleaning_date
    if (!raw) continue
    probe.withCleaningDate++

    // Substring rather than Date parsing: the value is documented as being in
    // the PROPERTY's timezone with no offset, so constructing a Date would
    // reinterpret it as UTC and shift the date across midnight boundaries —
    // which would corrupt the very comparison being made.
    const [datePart, timePart] = raw.split('T')
    if (datePart && b.departure && datePart === b.departure.slice(0, 10)) probe.derivedFromCheckout++
    if (timePart && !timePart.startsWith('00:00')) probe.withTimeOfDay++
  }

  return probe
}

/** An OwnerRez booking row whose property resolved to a FieldStay property. */
export type MappedOwnerRezBookingRow = OwnerRezBookingRow & { property_id: string }

/**
 * Splits built rows into those whose OwnerRez property resolved to a
 * FieldStay property and a count of those that did not.
 *
 * bookings.property_id is NOT NULL, so an unresolved row cannot be stored at
 * all — and because the upsert is a SINGLE multi-row statement, one such row
 * makes Postgres reject the WHOLE batch (23502), losing every other booking
 * in the same sync. Dropping them here keeps one unmapped property from
 * taking down the org's entire booking sync; the caller logs the count so the
 * skip stays visible rather than silent.
 */
export function partitionMappedBookingRows(rows: OwnerRezBookingRow[]): {
  mapped:        MappedOwnerRezBookingRow[]
  unmappedCount: number
} {
  const mapped = rows.filter(
    (r): r is MappedOwnerRezBookingRow => r.property_id !== null
  )
  return { mapped, unmappedCount: rows.length - mapped.length }
}

/**
 * Selects newly-upserted confirmed guest-stay bookings eligible for revenue
 * posting, pairing each with its FieldStay booking id. Consolidates the
 * filter/map/filter chain previously duplicated verbatim in
 * ownerrez/initial-sync.ts and ownerrez/incremental-sync.ts.
 */
export function selectOwnerRezBookingsToPostRevenue(
  rows:           OwnerRezBookingRow[],
  idByExternalId: Record<string, string>,
  /**
   * Earliest check-in date eligible for revenue posting (YYYY-MM-DD), or null
   * for no floor.
   *
   * Revenue for a stay that predates FieldStay managing the property is
   * REVENUE WITHOUT ITS EXPENSES, and that is worse than no data. All three
   * expense sources on owner_transactions post when something COMPLETES inside
   * FieldStay — cleaning_fee on turnover completion, wo_completion on a work
   * order, inventory_purchase on a received PO — and none of those exist for a
   * stay that happened before the account connected. Those jobs were done on
   * paper or in another system and cannot be reconstructed.
   *
   * So a backfilled month would show full rent and zero costs: an inflated net
   * income presented to a property owner as their P&L. A missing month is
   * visibly missing; a wrong month is not.
   *
   * The bookings themselves are still imported across the whole backfill —
   * they feed stay-length derivation for the par engine and occupancy history,
   * neither of which is distorted by the absent expense side.
   */
  minCheckinDate: string | null = null,
): { bookingId: string; propertyId: string; actualTotalAmount: number | null }[] {
  return rows
    .filter((b) => b.status === 'confirmed' && b.stay_type === 'guest_stay' && b.property_id !== null)
    // ISO dates compare correctly as strings: fixed width, zero padded,
    // most-significant first.
    .filter((b) => minCheckinDate === null || (b.checkin_date ?? '') >= minCheckinDate)
    .map((b) => ({
      bookingId:         idByExternalId[b.external_id],
      propertyId:        b.property_id as string,
      actualTotalAmount: b.actual_total_amount,
    }))
    .filter((b): b is { bookingId: string; propertyId: string; actualTotalAmount: number | null } => !!b.bookingId)
}
