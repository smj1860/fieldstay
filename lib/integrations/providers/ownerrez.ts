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

import type {
  IntegrationProvider,
  TokenResponse,
  OwnerRezProperty,
  OwnerRezListing,
  OwnerRezListingAmenityCategory,
  OwnerRezBooking,
} from '../types'
import type { NormalizedBooking } from '@/lib/bookings/normalize'
import { unmappedBookingStatus } from '@/lib/bookings/normalize'
import { ok, fail, timingSafeEqual } from '../webhook-verification'

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
    throw new Error(
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
  // webhooks comes entirely from the processed_webhooks dedup table, not
  // from anything checked here.
  async validateWebhook(request: Request) {
    const authHeader = request.headers.get('Authorization')

    if (!authHeader?.startsWith('Basic ')) return fail('missing or malformed Authorization header')

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8')
    // String.split(':', 2) does NOT split on the first colon only — it splits
    // on every colon, then truncates the resulting array to 2 entries, so a
    // password containing a colon gets silently cut off after its own first
    // colon. Split on the first colon by index instead, matching HTTP Basic
    // Auth's actual "user:pass, only the first colon is a delimiter" spec.
    const sepIndex = decoded.indexOf(':')
    const user = sepIndex === -1 ? decoded : decoded.slice(0, sepIndex)
    const pass = sepIndex === -1 ? ''      : decoded.slice(sepIndex + 1)

    const expectedUser = process.env.OWNERREZ_WEBHOOK_USER
    const expectedPass = process.env.OWNERREZ_WEBHOOK_PASSWORD

    if (!expectedUser || !expectedPass) {
      throw new Error(
        'Missing OWNERREZ_WEBHOOK_USER or OWNERREZ_WEBHOOK_PASSWORD environment variables'
      )
    }

    // Constant-time comparison to prevent timing attacks
    const userMatch = timingSafeEqual(user, expectedUser)
    const passMatch = timingSafeEqual(pass, expectedPass)

    return (userMatch && passMatch) ? ok() : fail('credential mismatch')
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
          let connection: { user_id: string; org_id: string } | null = null
          if (externalUserId) {
            const { createServiceClient } = await import('@/lib/supabase/server')
            const supabase = createServiceClient({ system: 'lib/integrations/providers/ownerrez' })
            const { data: conn } = await supabase
              .from('integration_connections')
              .select('user_id, org_id')
              .eq('provider_id', 'ownerrez')
              .eq('external_user_id', externalUserId)
              .eq('status', 'active')
              .maybeSingle()
            if (conn?.org_id) connection = { user_id: conn.user_id, org_id: conn.org_id }
          }

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

export function mapOwnerRezBookingStatus(status: string): string {
  const s = status.toLowerCase()
  if (s === 'confirmed') return 'confirmed'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'tentative') return 'tentative'
  return unmappedBookingStatus('ownerrez', status)
}

export function mapOwnerRezChannelToSource(channel?: string): string {
  if (!channel) return 'other'
  const c = channel.toLowerCase()
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

function patchAddressFields(patch: Record<string, unknown>, addr: OwnerRezProperty['address']): void {
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
function patchDetailScalarFields(patch: Record<string, unknown>, detail: OwnerRezProperty): void {
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
  patch:    Record<string, unknown>,
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
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

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
 * OwnerRez's booking endpoint doesn't return a time-of-day for arrival/
 * departure (unlike Hospitable's check_in/check_out) — checkin_time and
 * checkout_time are left null, matching existing behavior; the bookings
 * table already treats both columns as nullable for this reason.
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
    checkin_time:  null,
    checkout_time: null,
    status:      isBlock ? 'blocked' : mapOwnerRezBookingStatus(b.status),
    // ✅ Confirmed live 2026-07-15 — OwnerRez's guest object has
    // first_name/last_name, not a combined name field (see OwnerRezBooking.guest
    // doc comment). No email field was ever present on this endpoint.
    guest_name:  [b.guest?.first_name, b.guest?.last_name].filter(Boolean).join(' ') || null,
    guest_email: null,
    source:      mapOwnerRezChannelToSource(b.channel_name),
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
  status:              string
  guest_name:          string | null
  guest_email:         string | null
  source:              string
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
 * checkin_time/checkout_time are intentionally omitted — OwnerRez never
 * provides a time-of-day, so writing null on every sync would silently
 * clobber a PM's manual edit to those fields (see
 * app/(dashboard)/bookings/actions.ts). Omitting the keys leaves them
 * untouched on conflict.
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
 * Selects newly-upserted confirmed guest-stay bookings eligible for revenue
 * posting, pairing each with its FieldStay booking id. Consolidates the
 * filter/map/filter chain previously duplicated verbatim in
 * ownerrez/initial-sync.ts and ownerrez/incremental-sync.ts.
 */
export function selectOwnerRezBookingsToPostRevenue(
  rows:           OwnerRezBookingRow[],
  idByExternalId: Record<string, string>
): { bookingId: string; propertyId: string; actualTotalAmount: number | null }[] {
  return rows
    .filter((b) => b.status === 'confirmed' && b.stay_type === 'guest_stay' && b.property_id !== null)
    .map((b) => ({
      bookingId:         idByExternalId[b.external_id],
      propertyId:        b.property_id as string,
      actualTotalAmount: b.actual_total_amount,
    }))
    .filter((b): b is { bookingId: string; propertyId: string; actualTotalAmount: number | null } => !!b.bookingId)
}
