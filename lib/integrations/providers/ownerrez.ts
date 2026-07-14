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
  // OwnerRez uses generic action names (entity_insert/entity_update/entity_delete)
  // with entity type carried separately in the entity_type field.
  async handleWebhookEvent({ action, payload, externalUserId: _externalUserId, correlationId }) {
    const data       = payload as Record<string, unknown>
    const entityType = String(data.entity_type ?? '')
    const entityId   = String(data.entity_id ?? '')

    switch (action) {
      case 'application_authorization_revoked':
        // Handled by the generic webhook route — nothing to do here
        break

      case 'entity_insert':
      case 'entity_update':
      case 'entity_delete': {
        if (entityType === 'booking') {
          const { inngest } = await import('@/lib/inngest/client')
          await inngest.send({
            name: 'integration/ownerrez.sync.requested',
            data: {
              provider_id:    'ownerrez',
              event_type:     action,
              entity_type:    'booking',
              entity_id:      entityId,
              triggered_at:   new Date().toISOString(),
              correlation_id: correlationId ?? null,
            },
          })
        } else if (entityType === 'guest') {
          const { inngest } = await import('@/lib/inngest/client')
          await inngest.send({
            name: 'integration/ownerrez.sync.requested',
            data: {
              provider_id:    'ownerrez',
              event_type:     action,
              entity_type:    'guest',
              entity_id:      entityId,
              triggered_at:   new Date().toISOString(),
              correlation_id: correlationId ?? null,
            },
          })
        } else {
          // property, review, etc. — not yet wired to a specific handler.
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

/**
 * Builds the DB patch for a property's enrichment pass (address, lat/lng,
 * occupancy/rules from the detail endpoint; WiFi/instructions/house
 * manual/amenities from the listings endpoint — WiFi and instructions are
 * fill-only-if-null against `existing`, matching FieldStay's Hospitable
 * mapper policy; everything else always overwrites). Pure function — no
 * I/O — extracted from the per-property enrichment step in
 * ownerrez/initial-sync.ts for direct unit test coverage.
 *
 * Fixes an inconsistency found while extracting this: several detail
 * fields used truthy checks (`if (detail.latitude)`) instead of explicit
 * null/undefined checks, meaning a legitimate value of exactly 0 (or,
 * for min_renter_age, an explicit null clearing a prior value) would be
 * silently skipped. Low real-world likelihood (no real US property sits
 * on the equator or requires a minimum renter age of 0), but corrected
 * for consistency with the rest of the codebase's null-handling
 * convention now that it's being pulled out for direct testing.
 */
export function buildOwnerRezDetailPatch(
  existing: {
    wifi_name:           string | null
    wifi_password:       string | null
    access_instructions: string | null
    house_manual:        string | null
  },
  detail:  OwnerRezProperty | null,
  listing: OwnerRezListing | undefined
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (detail) {
    const defaultAddress =
      (detail.addresses ?? []).find((a) => a.is_default) ??
      (detail.addresses ?? [])[0]

    if (defaultAddress) {
      if (defaultAddress.street1)     patch.address = defaultAddress.street1
      if (defaultAddress.state)       patch.state   = defaultAddress.state
      if (defaultAddress.city)        patch.city    = defaultAddress.city
      if (defaultAddress.postal_code) patch.zip     = defaultAddress.postal_code
    }

    if (detail.latitude       !== null && detail.latitude       !== undefined) patch.lat            = detail.latitude
    if (detail.longitude      !== null && detail.longitude      !== undefined) patch.lng            = detail.longitude
    if (detail.max_guests     !== null && detail.max_guests     !== undefined) patch.max_guests      = detail.max_guests
    if (detail.smoking_allowed !== null && detail.smoking_allowed !== undefined) patch.smoking_allowed = detail.smoking_allowed
    if (detail.pets_allowed    !== null && detail.pets_allowed    !== undefined) patch.pets_allowed    = detail.pets_allowed
    if (detail.max_pets        !== null && detail.max_pets        !== undefined) patch.max_pets        = detail.max_pets
    if (detail.events_allowed  !== null && detail.events_allowed  !== undefined) patch.events_allowed  = detail.events_allowed
    if (detail.min_renter_age  !== null && detail.min_renter_age  !== undefined) patch.min_renter_age  = detail.min_renter_age
  }

  if (listing) {
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

  return patch
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
    guest_name:  b.guest?.name  ?? null,
    guest_email: b.guest?.email ?? null,
    source:      mapOwnerRezChannelToSource(b.channel_name),
    is_block:    isBlock,
    // Effective 2026-07-07, OwnerRez's type field can be 'owner' — the
    // property owner's own personal-use stay. It's a full booking (not a
    // block; is_block is false), so it flows through the same upsert path
    // as a guest booking and still gets a turnover — just tagged.
    stay_type:   b.type === 'owner' ? 'owner_stay' : 'guest_stay',
    // OwnerRez has no per-booking real-total field today — revenue posting
    // for OwnerRez bookings still relies on the avg_nightly_rate estimate.
    actual_total_amount: null,
  }
}
