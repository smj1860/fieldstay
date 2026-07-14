// lib/integrations/providers/hospitable.ts
// ============================================================
// Hospitable OAuth 2.0 provider adapter.
//
// Hospitable specifics:
//   - Full browser-redirect OAuth2 (authorization code grant)
//   - API base: https://public.api.hospitable.com/v2
//   - Properties paginated via links.next (cursor style)
//   - Reservations paginated via page/per_page + meta.last_page
//   - reservation_status.current.category is the canonical status field
//   - Webhook auth: HMAC-SHA256, header 'Signature', raw hex digest, no prefix
//   - Token expiry: access tokens 12 hours, refresh tokens 90 days
// ============================================================

import { RateLimitError, type IntegrationProvider, type TokenResponse } from '@/lib/integrations/types'
import type { CrewRole } from '@/types/database'
import { hospitableApiLimiter } from '@/lib/rate-limit'
import type { NormalizedProperty } from '@/lib/properties/normalize'
import type { NormalizedBooking } from '@/lib/bookings/normalize'
import { unmappedBookingStatus } from '@/lib/bookings/normalize'
import { ok, fail, timingSafeEqual, extractClientIp, isIpInCidr } from '@/lib/integrations/webhook-verification'

// ── Constants ────────────────────────────────────────────────────────────────

const HOSPITABLE_AUTHORIZE_URL = 'https://auth.hospitable.com/oauth/authorize'
const HOSPITABLE_TOKEN_URL     = 'https://auth.hospitable.com/oauth/token'
const HOSPITABLE_API_BASE      = 'https://public.api.hospitable.com/v2'

// Hospitable's own webhook docs advise whitelisting only this range.
// Defense-in-depth alongside the HMAC signature check below, which remains
// the primary control — an out-of-range request is rejected before it's
// worth spending a crypto comparison on.
const HOSPITABLE_WEBHOOK_IP_CIDR = '38.80.170.0/24'

// ── Hospitable API response types ────────────────────────────────────────────

export interface HospitableUser {
  id:      string   // UUID
  email:   string
  name:    string
  company: string | null
}

export interface HospitableAddress {
  number:   string | null
  street:   string | null
  city:     string | null
  state:    string | null
  country:  string | null
  postcode: string | null
}

export interface HospitableProperty {
  id:            string   // UUID — use as external_id
  name:          string
  public_name:   string
  picture:       string | null   // ⚠️ Unconfirmed shape — may be an object (thumbnail/original), not yet inspected
  address:       HospitableAddress
  timezone:      string
  listed:        boolean

  // ✅ Confirmed live (2026-07-06) — real field names, NOT "check-in"/"check-out".
  // Prior code assumed hyphenated keys per the REST spec's example, which do
  // not exist in the actual response — every sync before this fix silently
  // fell back to the '15:00'/'11:00' defaults instead of the real times.
  checkin:  string   // "HH:MM"
  checkout: string   // "HH:MM"

  capacity: {
    max:       number | null
    bedrooms:  number | null
    beds:      number | null
    bathrooms: number | null   // ✅ Confirmed live via include=details
  }
  room_details: Array<{ type: string; beds: Array<{ type: string; quantity: number }> }>
  property_type: string
  room_type:     string

  // ── The following are populated by include=details.
  // ✅ Confirmed live (2026-07-06):
  amenities:   string[] | null   // e.g. ['ac', 'dishwasher', 'wireless_internet', ...]
  currency:    string   | null   // e.g. 'USD'
  description: string   | null   // '' (empty string) when unset, not null
  summary:     string   | null   // '' (empty string) when unset, not null
  house_rules: {
    pets_allowed:    boolean | null
    smoking_allowed: boolean | null
    events_allowed:  boolean | null
  } | null

  // ⚠️ Unconfirmed shape — present in the raw response, not yet inspected.
  tags:                string[] | null
  calendar_restricted: boolean  | null
  parent_child:        unknown  | null   // likely multi-unit/parent-listing linkage

  // ✅ Confirmed live (2026-07-06) — house_manual/wifi credentials are NOT
  // top-level fields despite include=details; they're nested under this
  // `details` object instead. Note the field is `wifi_name`, NOT
  // `wifi_network` as first assumed before live verification.
  //
  // wifi_password (and anything typed into house_manual, which often embeds
  // it as free text) is a credential, not property metadata — do NOT persist
  // it onto the `properties` table or any row a wider audience (e.g. the
  // owner portal) can select from. Route guest/crew-facing WiFi info through
  // guidebook_property_configs instead, which already exists for exactly
  // this purpose and is scoped by its own RLS policy. Never log wifi_name,
  // wifi_password, or house_manual — redact to presence/length only.
  details: {
    space_overview:            string | null
    guest_access:              string | null
    house_manual:              string | null
    other_details:             string | null
    additional_rules:          string | null
    neighborhood_description:  string | null
    getting_around:            string | null
    wifi_name:                 string | null
    wifi_password:             string | null
  } | null

  // 📄 Spec only — NOT yet confirmed against a live response, and not
  // confirmed to require any include beyond what property:read already
  // grants (Hospitable's published example bundles every field group
  // together, which this codebase has already found to be misleading once
  // for this same endpoint — see the check-in/checkin correction above).
  // Verify against a real synced property before trusting this shape.
  // Money values are integer cents (e.g. 12345 → "$123.45"), matching
  // every other monetary field Hospitable documents.
  bookings?: {
    fees?: Array<{
      name:  string   // e.g. 'cleaning_fee', 'managment_fee' (sic, per spec)
      type:  'fixed' | 'percent'
      value: number | { amount: number; formatted: string }
    }>
  } | null
}

export interface HospitableReservationStatus {
  category:     'request' | 'accepted' | 'cancelled' | 'not accepted' | 'unknown' | 'checkpoint'
  sub_category: string
}

export interface HospitableGuest {
  first_name:    string | null
  last_name:     string | null
  email:         string | null
  phone_numbers: string[] | null
}

export interface HospitableGuestCounts {
  total:        number
  adult_count:  number
  child_count:  number
  infant_count: number
  pet_count:    number
}

export interface HospitableReservation {
  id:               string   // UUID
  platform:         string   // 'airbnb' | 'homeaway' | 'booking' | 'direct' | ...
  platform_id:      string   // Channel-native confirmation code

  // All four fields are ISO datetime strings (format: date-time), NOT plain
  // date or time strings.
  //   arrival_date / departure_date — date portion only, at midnight:
  //     e.g. "2019-01-03T00:00:00-05:00" → extract date with .split('T')[0]
  //   check_in / check_out — the actual check-in/out time of day:
  //     e.g. "2019-01-03T13:00:00-05:00" → extract HH:MM with extractHospitableTime()
  arrival_date:     string
  departure_date:   string
  check_in:         string
  check_out:        string

  reservation_status: { current: HospitableReservationStatus }

  // guests = GuestCounts (adults, children, infants, pets) — always present.
  // guest  = GuestInfo (name, email, phone) — only present when include=guest.
  guests:  HospitableGuestCounts
  guest?:  HospitableGuest | null

  // properties = array[Property], populated when include=properties is passed.
  // Confirmed from the official Hospitable webhook spec — the response key
  // is plural (properties), matching the request param name. Use
  // properties?.[0]?.id, not a singular 'property' key.
  properties?: Array<{
    id:          string
    name:        string
    public_name: string
  }> | null

  // Distinguishes the property owner staying at their own listing from a
  // real paying guest reservation. owner_stay is only populated (and only
  // meaningful) when stay_type is 'owner_stay'.
  stay_type?: 'guest_stay' | 'owner_stay'
  owner_stay?: { schedule_cleaning: boolean } | null

  // 📄 Spec — gated on financials:read, which is NOT yet granted (see
  // "Scopes to Request from Patrick" in api-reference.md). Shape below is
  // from Hospitable's own published "Update Reservation" example response
  // (2026-07-10) — a real documented structure, not a guess like the
  // previous version of this type — but still unconfirmed against our own
  // live GET /reservations?include=financials response, so treat the
  // exact field presence/nesting as provisional until verified.
  financials?: {
    host?: {
      revenue?: HospitableMoneyValue   // label "Gross Revenue" — the figure that matters for owner_transactions
    }
    guest?: {
      total_price?: HospitableMoneyValue   // what the guest paid in total — includes fees/taxes the host doesn't keep
    }
    currency?: string
  } | null
}

// Common money-value shape used throughout Hospitable's API — integer
// cents + a pre-formatted display string, plus (on financials line items
// specifically) a label/category pair we don't currently use.
interface HospitableMoneyValue {
  amount:    number
  formatted: string
  label?:    string
  category?: string
}

export interface HospitableTeammate {
  id:             string         // UUID — use as external_id
  name:           string | null  // Full name (first_name + last_name combined)
  first_name:     string | null
  last_name:      string | null
  is_company:     boolean
  company_name:   string | null
  email:          string | null
  phone_number:   string | null  // Note: Hospitable uses phone_number, not phone
  all_services:   boolean
  all_properties: boolean
  services:       Array<{ id: number; label: string }>
}

export interface HospitablePagedTeammates {
  data: HospitableTeammate[]
  links: {
    next: string | null
    prev: string | null
  }
}

export interface HospitablePagedProperties {
  data:  HospitableProperty[]
  links: {
    first: string | null
    last:  string | null
    prev:  string | null
    next:  string | null
  }
}

export interface HospitablePagedReservations {
  data: HospitableReservation[]
  meta: {
    current_page: number
    last_page:    number
    per_page:     number
    total:        number
  }
}

// GET /reservations/{uuid}/messages — no per-message id in the documented
// response shape (only conversation_id/reservation_id at the message-list
// level), so callers derive their own dedup key from conversation_id +
// created_at + sender_type + a hash of body. attachments/reactions are
// typed loosely (unknown[]) — not consumed by FieldStay today, just
// preserved for a future UI.
export interface HospitableMessage {
  platform:          string
  platform_id:       number
  conversation_id:   string
  reservation_id:    string | null
  content_type:      string
  body:              string
  attachments:       unknown[] | null
  sender_type:       'host' | 'guest'
  sender_role:       string | null
  sender: {
    first_name:    string | null
    full_name:     string | null
    locale:        string | null
    picture_url:   string | null
    thumbnail_url: string | null
    location:      string | null
  } | null
  created_at:        string
  source:            string
  integration:       string | null
  sent_reference_id: string | null
}

export interface HospitablePagedMessages {
  data: HospitableMessage[]
}

// ── Provider adapter ─────────────────────────────────────────────────────────

export const hospitableProvider: IntegrationProvider = {
  id:          'hospitable',
  displayName: 'Hospitable',
  authType:    'oauth2',

  getAuthorizationUrl({ state }) {
    // redirect_uri and scope are configured in the partner portal — not sent as URL params.
    // state is included for CSRF protection.
    const url = new URL(HOSPITABLE_AUTHORIZE_URL)
    url.searchParams.set('client_id',     process.env.HOSPITABLE_CLIENT_ID!)
    url.searchParams.set('response_type', 'code')
    if (state) url.searchParams.set('state', state)
    return url.toString()
  },

  async exchangeCodeForToken({ code }): Promise<TokenResponse> {
    // Credentials go in the JSON body — NOT Basic Auth header.
    // redirect_uri is NOT required (portal-configured).
    const clientId     = process.env.HOSPITABLE_CLIENT_ID
    const clientSecret = process.env.HOSPITABLE_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      throw new Error('Missing HOSPITABLE_CLIENT_ID or HOSPITABLE_CLIENT_SECRET')
    }

    const response = await fetch(HOSPITABLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'authorization_code',
        code,
      }),
    })

    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const body = await response.json() as { error?: string; error_description?: string }
        detail = body.error_description ?? body.error ?? detail
      } catch { /* ignore JSON parse failure */ }
      throw new Error(`Hospitable token exchange failed: ${detail}`)
    }

    const data = await response.json() as {
      access_token:   string
      token_type:     string
      expires_in?:    number
      refresh_token?: string
      scope?:         string
    }

    if (!data.access_token) {
      throw new Error('Hospitable returned no access_token')
    }

    // Fetch the user ID immediately after exchange for a stable external identifier
    const userRes = await fetch(`${HOSPITABLE_API_BASE}/user`, {
      headers: {
        'Authorization': `Bearer ${data.access_token}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
      },
    })

    if (!userRes.ok) {
      throw new Error(`Hospitable /user fetch failed: HTTP ${userRes.status}`)
    }

    const userData = await userRes.json() as { data: HospitableUser }
    const user     = userData.data

    const result: TokenResponse = {
      accessToken:    data.access_token,
      externalUserId: user.id,
      scope:          data.scope,
      metadata: {
        user_email:   user.email,
        user_name:    user.name,
        company_name: user.company ?? null,
      },
    }

    if (data.refresh_token) result.refreshToken = data.refresh_token
    if (data.expires_in)    result.expiresAt    = new Date(Date.now() + data.expires_in * 1000).toISOString()

    return result
  },

  // Access tokens expire after 12 hours; refresh tokens after 90 days.
  // After a refresh, the old refresh_token remains valid for up to 60 minutes —
  // always store the NEW tokens immediately.
  async refreshAccessToken({ refreshToken }): Promise<TokenResponse> {
    const clientId     = process.env.HOSPITABLE_CLIENT_ID
    const clientSecret = process.env.HOSPITABLE_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      throw new Error('Missing HOSPITABLE_CLIENT_ID or HOSPITABLE_CLIENT_SECRET')
    }

    const response = await fetch(HOSPITABLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
      }),
    })

    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const body = await response.json() as { error?: string; error_description?: string }
        detail = body.error_description ?? body.error ?? detail
      } catch { /* ignore */ }
      throw new Error(`Hospitable token refresh failed: ${detail}`)
    }

    const data = await response.json() as {
      access_token:   string
      expires_in?:    number
      refresh_token?: string
      scope?:         string
    }

    if (!data.access_token) {
      throw new Error('Hospitable refresh returned no access_token')
    }

    const result: TokenResponse = {
      accessToken:    data.access_token,
      externalUserId: '',   // Not re-fetched on refresh — already stored in Vault
      scope:          data.scope,
    }

    if (data.refresh_token) result.refreshToken = data.refresh_token
    if (data.expires_in)    result.expiresAt    = new Date(Date.now() + data.expires_in * 1000).toISOString()

    return result
  },

  getApiHeaders(token: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    }
  },

  // Webhook auth: header 'Signature' (capital S), HMAC-SHA256 of raw body, raw hex, no prefix.
  // IP range: 38.80.170.0/24 (checked below, ahead of the signature — cheap
  // rejection for obviously-wrong-source traffic before spending a crypto
  // comparison on it).
  // Hospitable's HMAC is computed over the body only — there is no timestamp
  // in the signed payload, so replay protection comes entirely from the
  // processed_webhooks dedup table, not from anything checked here.
  async validateWebhook(request: Request) {
    const clientIp = extractClientIp(request)
    if (!clientIp || !isIpInCidr(clientIp, HOSPITABLE_WEBHOOK_IP_CIDR)) {
      return fail(`source IP not in Hospitable's allowed range: ${clientIp ?? 'unknown'}`)
    }

    const secret = process.env.HOSPITABLE_WEBHOOK_SECRET
    if (!secret) {
      console.error('[Hospitable] HOSPITABLE_WEBHOOK_SECRET not set — rejecting webhook')
      return fail('HOSPITABLE_WEBHOOK_SECRET not configured')
    }

    const signatureHeader = request.headers.get('Signature')
    if (!signatureHeader) return fail('missing Signature header')

    const body = await request.text()

    const { createHmac } = await import('crypto')
    const expected = createHmac('sha256', secret).update(body).digest('hex')

    return timingSafeEqual(signatureHeader, expected) ? ok() : fail('signature mismatch')
  },

  // Webhook payload: { id, action, data, created, version, triggers }
  // action 'reservation.changed' covers both create and update.
  // reservation.created (new bookings) is also sent — confirmed via Vercel
  // logs (action="reservation.created"). There is NO 'reservation.cancelled'
  // action — cancellations fire as 'reservation.changed' with
  // triggers: ["status_changed"]; incremental sync detects the cancellation
  // by re-fetching the reservation and checking reservation_status.current.category.
  // Webhooks are configured globally in the partner portal — no per-account registration.
  //
  // ⚠️ reservation.changed sends a PARTIAL payload — confirmed from
  // Hospitable's own docs example: a checkin-time-only change delivers
  // data: { check_in: "..." }, with no `id` field on data at all. The
  // reservation's own id is on the TOP-LEVEL payload.id instead for this
  // event (differs from review.created, where the top-level id is the
  // webhook's own ULID and the entity id is nested under data.id) — check
  // data.id first for reservation.created (which may send the fuller
  // object) and fall back to the top-level id.
  async handleWebhookEvent({ action, payload }) {
    const data = payload as Record<string, unknown>

    const entityData = (Array.isArray(data.data) ? data.data[0] : data.data) as Record<string, unknown> | undefined
    const entityId   = entityData?.id as string | undefined

    switch (action) {
      case 'reservation.created':
      case 'reservation.changed': {
        const reservationId = entityId ?? (data.id as string | undefined)
        if (!reservationId) {
          console.warn('[Hospitable webhook] reservation event missing id (checked data.id and payload.id):', data)
          break
        }
        const { inngest } = await import('@/lib/inngest/client')
        const triggers = Array.isArray(data.triggers) ? data.triggers as string[] : undefined
        await inngest.send({
          name: 'integration/hospitable.sync.requested',
          data: {
            provider_id:  'hospitable',
            event_type:   action,
            entity_type:  'reservation',
            entity_id:    reservationId,
            triggers,
            triggered_at: new Date().toISOString(),
          },
        })
        break
      }

      case 'property.changed':
      case 'property.created':
      case 'property.updated':
      case 'property.deleted': {
        if (!entityId) {
          console.warn('[Hospitable webhook] property event missing data.id:', data)
          break
        }
        const { inngest } = await import('@/lib/inngest/client')
        await inngest.send({
          name: 'integration/hospitable.sync.requested',
          data: {
            provider_id:  'hospitable',
            event_type:   action,
            entity_type:  'property',
            entity_id:    entityId,
            triggered_at: new Date().toISOString(),
          },
        })
        break
      }

      // property.merged has a different payload shape from every other
      // property event — { previous_id, new_id }, no single `id` field —
      // so it can't go through the generic entityId extraction above.
      case 'property.merged': {
        const mergeData    = entityData as { previous_id?: string; new_id?: string } | undefined
        const previousId   = mergeData?.previous_id
        const newId        = mergeData?.new_id

        if (!previousId || !newId) {
          console.warn('[Hospitable webhook] property.merged missing previous_id/new_id:', data)
          break
        }

        const { inngest } = await import('@/lib/inngest/client')
        await inngest.send({
          name: 'integration/hospitable.property_merged',
          data: {
            provider_id:          'hospitable',
            previous_external_id: previousId,
            new_external_id:      newId,
            triggered_at:         new Date().toISOString(),
          },
        })
        break
      }

      case 'review.created':
      case 'review.changed': {
        if (!entityId) {
          console.warn('[Hospitable webhook] review event missing data.id:', data)
          break
        }
        const { inngest } = await import('@/lib/inngest/client')
        await inngest.send({
          name: 'integration/hospitable.sync.requested',
          data: {
            provider_id:  'hospitable',
            event_type:   action,
            entity_type:  'review',
            entity_id:    entityId,
            triggered_at: new Date().toISOString(),
          },
        })
        break
      }

      // ⚠️ Unconfirmed payload shape — Hospitable's public docs for this
      // webhook's body were not available when this was written (only the
      // REST GET /reservations/{uuid}/messages endpoint was documented,
      // via the partner portal's own webhook config screen listing
      // "Messages: when a new message is created"). Like reservation.changed,
      // this is expected to be a partial payload — an id/reservation
      // reference only, not the message body itself — so this just kicks
      // off the same fetch-then-upsert flow via Inngest. Tries the field
      // names used by every other Hospitable webhook before giving up.
      case 'message.created':
      case 'message.updated': {
        const messageReservationId =
          (entityData?.reservation_id as string | undefined)
          ?? entityId
          ?? (data.reservation_id as string | undefined)
          ?? (data.id as string | undefined)

        if (!messageReservationId) {
          console.warn('[Hospitable webhook] message event missing reservation_id (checked data.reservation_id, data.id, payload.id):', data)
          break
        }

        const { inngest } = await import('@/lib/inngest/client')
        await inngest.send({
          name: 'integration/hospitable.sync.requested',
          data: {
            provider_id:  'hospitable',
            event_type:   action,
            entity_type:  'message',
            entity_id:    messageReservationId,
            triggered_at: new Date().toISOString(),
          },
        })
        break
      }

      case 'integration.disconnected':
      case 'integration_disconnected':
      case 'application_authorization_revoked':
        // Handled upstream by the generic webhook route via revokeIntegrationToken()
        break

      default:
        console.log(`[Hospitable webhook] Unhandled action: "${action}" — payload id: ${data.id ?? 'unknown'}`)
    }
  },
}

// ── Hospitable API fetch helpers ──────────────────────────────────────────────

/**
 * Shared fetch wrapper for Hospitable's data endpoints (/properties,
 * /reservations, /teammates — NOT the OAuth token/user endpoints, which
 * have their own, much higher documented limit and stay on plain fetch()).
 *
 * Applies hospitableApiLimiter's proactive budget check first (throws our
 * own RateLimitError before Hospitable would actually 429 us), then falls
 * back to reactive handling if a real 429 comes back anyway — parses
 * Retry-After and throws RateLimitError with that exact wait time. Every
 * call site should use this instead of calling fetch() directly so both
 * layers apply uniformly. Inngest's own step retry handles backing off and
 * re-attempting — see translateSyncError() for the PM-facing message.
 */
export async function hospitableFetch(url: string, token: string): Promise<Response> {
  const { success, reset } = await hospitableApiLimiter.limit('hospitable-api')
  if (!success) {
    const retryAfterSeconds = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
    throw new RateLimitError(retryAfterSeconds)
  }

  const res = await fetch(url, { headers: hospitableProvider.getApiHeaders(token) })

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10)
    throw new RateLimitError(retryAfter)
  }

  return res
}

export async function hospFetchProperties(token: string): Promise<HospitableProperty[]> {
  const properties: HospitableProperty[] = []
  const PER_PAGE  = 100
  const MAX_PAGES = 200

  // 📄 bookings is speculative — see HospitableProperty.bookings' doc
  // comment. Appending it here costs nothing if Hospitable ignores an
  // include it doesn't recognize, and is what actually turns on the
  // cleaning-fee data once/if it's confirmed live.
  let url: string | null = `${HOSPITABLE_API_BASE}/properties?per_page=${PER_PAGE}&include=details,bookings`
  let pageCount = 0

  while (url) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      console.error(`[Hospitable] properties pagination exceeded ${MAX_PAGES} pages — aborting`)
      break
    }

    const res = await hospitableFetch(url, token)

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Hospitable /properties failed (${res.status}): ${text.slice(0, 200)}`)
    }

    const data = await res.json() as HospitablePagedProperties
    properties.push(...(data.data ?? []))
    url = data.links?.next ?? null
  }

  return properties
}

// Confirmed live 2026-07-10: GET /reservations applies a forward-looking
// window sized relative to start_date (per our doc's "defaults to next 2
// weeks if omitted" note), not an open "everything since start_date"
// range — a 90-day-in-the-past start_date returned meta.total: 0 for a
// real, listed, in-window test reservation on every attempt; 7 days
// immediately fixed it. Since the exact window size Hospitable applies
// isn't documented, hospFetchReservations() below chunks the desired
// range into WINDOW_DAYS-sized start_date steps and merges + dedupes the
// results by reservation id — this is safe regardless of what the true
// window size actually is, as long as it's >= WINDOW_DAYS (confirmed).
const RESERVATION_WINDOW_DAYS = 7

// How far forward to look on a full sync. New/changed reservations
// further out than this still arrive via the incremental webhook path
// (which fetches a single reservation by id, unaffected by this windowing
// issue at all), so this only bounds how far ahead a fresh initial
// sync/full resync backfills — not a hard ceiling on what FieldStay will
// ever know about.
const RESERVATION_LOOKAHEAD_MONTHS = 6

export async function hospFetchReservations(
  token: string,
  since?: string,
  propertyIds?: string[]
): Promise<HospitableReservation[]> {
  const rangeStart = since
    ? new Date(`${since}T00:00:00Z`)
    : new Date(Date.now() - RESERVATION_WINDOW_DAYS * 86_400_000)

  const rangeEnd = new Date(rangeStart)
  rangeEnd.setUTCMonth(rangeEnd.getUTCMonth() + RESERVATION_LOOKAHEAD_MONTHS)

  const byId = new Map<string, HospitableReservation>()

  for (
    let windowStart = rangeStart;
    windowStart < rangeEnd;
    windowStart = new Date(windowStart.getTime() + RESERVATION_WINDOW_DAYS * 86_400_000)
  ) {
    const startDateStr = windowStart.toISOString().split('T')[0]!
    const windowReservations = await fetchReservationsWindow(token, startDateStr, propertyIds)
    for (const r of windowReservations) byId.set(r.id, r)
  }

  return Array.from(byId.values())
}

// Single start_date window, fully paginated. See RESERVATION_WINDOW_DAYS'
// doc comment above for why hospFetchReservations() calls this in a loop
// rather than once with one big range.
async function fetchReservationsWindow(
  token: string,
  startDate: string,
  propertyIds?: string[]
): Promise<HospitableReservation[]> {
  const reservations: HospitableReservation[] = []
  const PER_PAGE  = 100
  const MAX_PAGES = 200

  let page      = 1
  let lastPage  = 1
  let pageCount = 0

  while (page <= lastPage) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      console.error(`[Hospitable] reservations pagination exceeded ${MAX_PAGES} pages — aborting`)
      break
    }

    // Build base params via URLSearchParams (handles encoding for all standard params)
    // financials requires financials:read — confirmed live 2026-07-10.
    const params = new URLSearchParams({
      page:       String(page),
      per_page:   String(PER_PAGE),
      start_date: startDate,
      include:    'guest,properties,financials',
      date_query: 'checkin',
    })

    // properties[] must use literal brackets — URLSearchParams encodes [] as %5B%5D
    // which Hospitable does not accept. Build this portion of the URL manually.
    // Each id is still percent-encoded individually so a malformed value can't
    // inject extra query params.
    const propertiesQuery = (propertyIds ?? [])
      .map((id) => `properties[]=${encodeURIComponent(id)}`)
      .join('&')

    // status[] intentionally omitted — confirmed live 2026-07-10 that
    // Hospitable's undocumented default already includes a manually-created
    // test reservation; explicitly listing every accepted filter value
    // (request/accepted/cancelled/not_accepted/checkpoint) would still
    // structurally exclude the "unknown" response category, since it has
    // no corresponding valid filter value.
    const url = `${HOSPITABLE_API_BASE}/reservations?${params.toString()}`
      + (propertiesQuery ? `&${propertiesQuery}` : '')

    const res = await hospitableFetch(url, token)

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Hospitable /reservations failed (${res.status}): ${text.slice(0, 200)}`)
    }

    const data = await res.json() as HospitablePagedReservations
    reservations.push(...(data.data ?? []))

    lastPage = data.meta?.last_page ?? page
    page++
  }

  return reservations
}

export interface HospitableCalendarDayStatus {
  reason:      string
  source:      string | null
  source_type: string | null
  available:   boolean
}

export interface HospitableCalendarDay {
  date:                string
  day:                 string
  min_stay:            number
  note:                string | null
  closed_for_checkin:  boolean
  closed_for_checkout: boolean
  status:              HospitableCalendarDayStatus
  price:               { amount: number; currency: string; formatted: string }
}

interface HospitablePagedCalendar {
  data: {
    start_date: string
    end_date:   string
    days:       HospitableCalendarDay[]
  }
}

// GET /properties/{uuid}/calendar — needs calendar:read, confirmed live
// 2026-07-10 against a real payload (see api-reference.md's "Calendar /
// Availability" section). Day-level, no pagination — start_date/end_date
// bound the whole response in one call.
export async function hospFetchCalendar(
  token:      string,
  propertyId: string,
  startDate:  string,
  endDate:    string
): Promise<HospitableCalendarDay[]> {
  const url = `${HOSPITABLE_API_BASE}/properties/${propertyId}/calendar?start_date=${startDate}&end_date=${endDate}`
  const res = await hospitableFetch(url, token)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hospitable /properties/${propertyId}/calendar failed (${res.status}): ${text.slice(0, 200)}`)
  }

  const data = await res.json() as HospitablePagedCalendar
  return data.data?.days ?? []
}

export interface HospitableBlockRange {
  checkin_date:  string
  checkout_date: string
}

// A manually-blocked day is unavailable AND set by the PM, not a channel —
// confirmed live 2026-07-10 against a real block: {reason: "BLOCKED",
// source: null, source_type: "USER", available: false}. A real reservation
// covering the same property instead reports source_type: "RESERVATION",
// so the two are never confused without needing to cross-reference the
// bookings table at all. Consecutive blocked days are merged into a single
// range; checkout_date is the day after the last blocked night, matching
// every other provider's checkin/checkout semantics in this codebase.
export function consolidateHospitableBlocks(
  days: HospitableCalendarDay[]
): HospitableBlockRange[] {
  const ranges: HospitableBlockRange[] = []
  let rangeStart: string | null = null
  let lastBlockedDate: string | null = null

  const isManualBlock = (day: HospitableCalendarDay) =>
    !day.status.available && day.status.source_type === 'USER'

  const closeRange = () => {
    if (rangeStart && lastBlockedDate) {
      ranges.push({ checkin_date: rangeStart, checkout_date: addOneDay(lastBlockedDate) })
    }
    rangeStart = null
    lastBlockedDate = null
  }

  for (const day of days) {
    if (isManualBlock(day)) {
      if (!rangeStart) rangeStart = day.date
      lastBlockedDate = day.date
      continue
    }
    closeRange()
  }
  closeRange()

  return ranges
}

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0]!
}

// GET /reservations/{uuid}/messages — rate-limited by Hospitable to 2
// requests/minute PER RESERVATION, much tighter than the general API budget
// hospitableApiLimiter enforces. Deliberately not given its own proactive
// limiter (would need a per-reservation key, adding real complexity for an
// endpoint the Inngest concurrency limit — { limit: 2, key: 'entity_id' } in
// incremental-sync.ts — already throttles per reservation); relies on
// hospitableFetch's reactive 429 handling (Retry-After header) plus
// Inngest's built-in step retries to absorb bursts instead.
export async function hospFetchReservationMessages(
  token:         string,
  reservationId: string
): Promise<HospitableMessage[]> {
  const res = await hospitableFetch(
    `${HOSPITABLE_API_BASE}/reservations/${reservationId}/messages`,
    token
  )

  if (res.status === 404) return []

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `Hospitable GET /reservations/${reservationId}/messages failed (${res.status}): ${text.slice(0, 200)}`
    )
  }

  const data = await res.json() as HospitablePagedMessages
  return data.data ?? []
}

// Fetches all teammates for the authenticated account, paginated via
// links.next (same cursor style as properties). Non-fatal on failure —
// teammate sync is additive and must not abort the rest of initial sync
// (e.g. an existing connection without the teammate:read scope gets 403).
export async function hospFetchTeammates(token: string): Promise<HospitableTeammate[]> {
  const teammates: HospitableTeammate[] = []
  const MAX_PAGES = 50

  let url: string | null = `${HOSPITABLE_API_BASE}/teammates?per_page=100`
  let pageCount = 0

  while (url) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      console.error('[Hospitable] teammates pagination exceeded limit — aborting')
      break
    }

    const res = await hospitableFetch(url, token)

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(
        `[Hospitable] GET /teammates failed (${res.status}): ${text.slice(0, 200)}`
      )
      return []
    }

    const data = await res.json() as HospitablePagedTeammates
    teammates.push(...(data.data ?? []))
    url = data.links?.next ?? null
  }

  return teammates
}

// Converts Hospitable's flat amenity slug array (e.g. ['ac', 'dishwasher'])
// into the Record<string, boolean> shape properties.amenities expects.
// Unlike OwnerRez's normalizeAmenities(), Hospitable's slugs are already
// clean snake_case — no title normalization needed.
export function normalizeHospitableAmenities(
  amenities: string[] | null
): Record<string, boolean> | null {
  if (!amenities?.length) return null
  return Object.fromEntries(amenities.map((a) => [a, true]))
}

// 📄 Spec only — see HospitableProperty.bookings' doc comment. Returns
// dollars (converts from integer cents), or null if the fee is absent or
// malformed in any way — never guesses a value from a partial match.
function extractHospitableCleaningFee(
  bookings: HospitableProperty['bookings']
): number | null {
  const fee = bookings?.fees?.find((f) => f.name === 'cleaning_fee')
  if (!fee || typeof fee.value !== 'object' || fee.value === null) return null

  const amount = fee.value.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null

  return Math.round(amount) / 100
}

// 📄 Spec only — see HospitableReservation.financials' doc comment. Tries
// each plausible key in priority order (host_payout is what a PM/owner
// actually receives, which is the more useful and more likely-present
// figure for owner_transactions than a raw "total" the guest paid) and
// returns dollars for the first one that's present and well-formed, or
// null if none match — a wrong/absent guess falls back to the existing
// avg_nightly_rate estimate in booking-events.ts, never a fabricated number.
function extractHospitableActualTotal(
  financials: HospitableReservation['financials']
): number | null {
  if (!financials) return null

  // host.revenue ("Gross Revenue") is what actually matters for
  // owner_transactions; guest.total_price is a fallback only — it's what
  // the guest paid overall, which can include host-passthrough fees/taxes
  // that don't belong in a revenue figure, but is still a real number
  // rather than nothing if revenue itself is ever absent.
  for (const value of [financials.host?.revenue, financials.guest?.total_price]) {
    if (!value || typeof value.amount !== 'number') continue
    if (!Number.isFinite(value.amount) || value.amount <= 0) continue
    return Math.round(value.amount) / 100
  }

  return null
}

/**
 * Maps a raw HospitableProperty into the shared NormalizedProperty shape
 * (see lib/properties/normalize.ts) for lib/properties/upsert-normalized.ts
 * to write. Pure function — no I/O, no org context (the writer supplies
 * org_id at write time).
 */
export function hospitablePropertyToNormalized(
  prop: HospitableProperty
): NormalizedProperty {
  const addr          = prop.address
  const addressParts  = [addr.number, addr.street].filter(Boolean)
  const addressStr    = addressParts.join(' ') || null
  // ?? only falls through on null/undefined, not 0 — if capacity.bedrooms
  // is null and no bedroom-type room_details exist, .length is 0 (not
  // null), so a trailing `?? 1` would never fire. Using `|| 1` on the
  // room_details fallback specifically ensures "found zero bedroom rooms"
  // (an unknown-data signal) still defaults to 1, while a genuine
  // capacity.bedrooms of 0 (e.g. a true studio) is preserved as-is.
  const bedroomCount  = prop.capacity.bedrooms
    ?? (prop.room_details.filter((r) => r.type === 'bedroom').length || 1)

  return {
    external_id: prop.id,
    name:        prop.public_name || prop.name,
    address:     addressStr,
    city:        addr.city ?? null,
    state:       addr.state ?? null,
    zip:         addr.postcode ?? null,
    bedrooms:    bedroomCount,
    bathrooms:   prop.capacity.bathrooms ?? 1,
    max_guests:  prop.capacity.max ?? 2,
    checkin_time:  prop.checkin  ?? '15:00',
    checkout_time: prop.checkout ?? '11:00',
    // prop.timezone is a UTC offset (e.g. "-0500"), not an IANA identifier.
    // Derive from property state for DST-correct Intl compatibility.
    timezone: resolveHospitableTimezone(prop.timezone, addr.state),
    amenities:       normalizeHospitableAmenities(prop.amenities),
    smoking_allowed: prop.house_rules?.smoking_allowed ?? null,
    pets_allowed:    prop.house_rules?.pets_allowed    ?? null,
    events_allowed:  prop.house_rules?.events_allowed  ?? null,

    // Content fields — also always overwritten; see lib/properties/
    // upsert-normalized.ts's logContentOverwrites() for the audit trail
    // written before a real existing value is replaced.
    wifi_name:           prop.details?.wifi_name     || null,
    wifi_password:       prop.details?.wifi_password || null,
    access_instructions: prop.details?.guest_access  || null,
    house_manual:        prop.details?.house_manual  || null,

    cleaning_cost: extractHospitableCleaningFee(prop.bookings),
  }
}

// ── Status mapping ────────────────────────────────────────────────────────────

export function mapHospitableStatus(
  category: HospitableReservationStatus['category']
): 'confirmed' | 'tentative' | 'cancelled' {
  switch (category) {
    case 'accepted':      return 'confirmed'
    // 'unknown' and 'checkpoint' are documented, legitimate Hospitable
    // categories (not unforeseen values) — an in-flight/ambiguous
    // reservation should map to 'tentative' explicitly, same as 'request',
    // rather than being lumped into the same default branch that also
    // catches genuinely unrecognized values.
    case 'request':
    case 'unknown':
    case 'checkpoint':    return 'tentative'
    case 'cancelled':
    case 'not accepted':  return 'cancelled'
    default:              return unmappedBookingStatus('hospitable', category)
  }
}

// Confirmed Hospitable channel platform keys: airbnb | homeaway | booking | agoda | ical | manual | direct
export function mapHospitableChannel(
  platform: string
): 'airbnb' | 'vrbo' | 'booking_com' | 'direct' | 'other' {
  const p = platform.toLowerCase()
  if (p === 'airbnb')                   return 'airbnb'
  if (p === 'homeaway')                 return 'vrbo'
  if (p === 'booking')                  return 'booking_com'
  if (p === 'direct' || p === 'manual') return 'direct'
  return 'other'
}

/**
 * Pure raw -> NormalizedBooking mapper for a Hospitable reservation.
 * Extracted from the previously-duplicated inline row-building logic in
 * hospitable/initial-sync.ts and hospitable/incremental-sync.ts —
 * consolidated here as the single source of truth, mirroring
 * hospitablePropertyToNormalized above.
 *
 * Fixes a gap found while extracting this: guest.email is available on
 * every reservation fetched with include=guest (see HospitableGuest),
 * but the inline code only ever captured guest_name, never guest_email.
 * Both call sites already request include=guest, so this is populated
 * for free with no additional API cost.
 */
export function hospitableReservationToNormalized(
  res: HospitableReservation
): NormalizedBooking {
  // res.guest (singular) = GuestInfo (name/email/phone), only present when
  // include=guest. res.guests (plural) = GuestCounts — not name data.
  const guest     = res.guest ?? null
  const guestName = guest
    ? [guest.first_name, guest.last_name].filter(Boolean).join(' ') || null
    : null

  return {
    external_id: res.id,
    // Confirmed from the official Hospitable webhook spec: 'properties' is
    // an array[Property], not a singular 'property' object.
    property_external_id: res.properties?.[0]?.id ?? null,

    // arrival_date / departure_date are ISO datetimes at midnight — extract
    // the date portion. check_in / check_out carry the actual time of day.
    checkin_date:  res.arrival_date?.split('T')[0]   ?? null,
    checkout_date: res.departure_date?.split('T')[0] ?? null,
    checkin_time:  extractHospitableTime(res.check_in,  '15:00'),
    checkout_time: extractHospitableTime(res.check_out, '11:00'),

    // Confirmed 2026-07-10: a manual block never appears through this
    // endpoint at all — Hospitable's reservation_status.current.category
    // enum (request/accepted/cancelled/not accepted/unknown/checkpoint) has
    // no "blocked" value, and a real manually-blocked date range simply
    // never produces a reservation object here. is_block is correctly
    // false for every real /reservations response; the only place a block
    // ever surfaces is GET /properties/{uuid}/calendar (day-level, separate
    // from reservations entirely), handled by
    // lib/inngest/functions/hospitable/calendar-sync-handler.ts — see
    // consolidateHospitableBlocks() and
    // docs/Integrations/hospitable/api-reference.md's "Calendar /
    // Availability" section for the confirmed status.reason/source_type
    // signal it detects blocks from.
    status:      mapHospitableStatus(res.reservation_status.current.category),
    guest_name:  guestName,
    guest_email: guest?.email ?? null,
    source:      mapHospitableChannel(res.platform),
    is_block:    false,
    stay_type:   res.stay_type === 'owner_stay' ? 'owner_stay' : 'guest_stay',

    actual_total_amount: extractHospitableActualTotal(res.financials),
  }
}

// Maps Hospitable service labels to the FieldStay crew_role enum
// (cleaning | landscaping | maintenance | general — the enum has no
// crew/manager/owner values, so Check-in, Check-out, Concierge, Manager,
// Owner, and any unrecognized label all fall back to 'general'; the raw
// Hospitable labels are preserved separately in crew_members.specialty).
export function mapHospitableTeammateRole(
  services: Array<{ label: string }>
): CrewRole {
  const labels = services.map((s) => s.label.toLowerCase())

  if (labels.includes('maintenance')) return 'maintenance'
  if (labels.includes('cleaning'))    return 'cleaning'
  if (labels.includes('laundry'))     return 'cleaning'

  return 'general'
}

// Derives a display name from a Hospitable teammate record.
// Prefers the pre-combined `name` field; falls back to
// first_name + last_name construction; falls back to company_name.
export function resolveHospitableTeammateName(t: HospitableTeammate): string | null {
  if (t.name) return t.name
  if (t.first_name || t.last_name) {
    return [t.first_name, t.last_name].filter(Boolean).join(' ')
  }
  if (t.is_company && t.company_name) return t.company_name
  return null
}

export interface HospitableCrewMemberRow {
  org_id:             string
  name:               string
  email:              string | null
  phone:              string | null
  role:               CrewRole
  is_active:          true
  specialty:          string | null
  reliability_score:  number
  capacity_score:     number
  external_id:        string
  external_source:    'hospitable'
}

/**
 * Maps raw HospitableTeammate records into crew_members upsert rows —
 * shared by hospitable/initial-sync.ts (first connect) and
 * hospitable/teammate-sync-handler.ts (daily resync) so both stay in sync
 * with the same role/specialty/name-resolution rules. Pure function — no
 * I/O; entries with no resolvable name are dropped (mirrors the original
 * initial-sync filtering).
 */
export function hospitableTeammatesToCrewRows(
  orgId:      string,
  teammates:  HospitableTeammate[]
): HospitableCrewMemberRow[] {
  return teammates
    .map((t) => ({ t, name: resolveHospitableTeammateName(t) }))
    .filter((entry): entry is { t: HospitableTeammate; name: string } =>
      entry.name !== null && entry.name.trim().length > 0
    )
    .map(({ t, name }) => ({
      org_id:            orgId,
      name,
      email:             t.email        ?? null,
      phone:             t.phone_number ?? null,
      role:              mapHospitableTeammateRole(t.services),
      is_active:         true,
      // reliability_score / capacity_score are 0–1 scale, NOT NULL — 1.0
      // matches the column DEFAULT and is a neutral starting score for
      // auto-assign-turnover's scoring algorithm.
      reliability_score: 1.0,
      capacity_score:    1.0,
      specialty:         t.services.length ? t.services.map((s) => s.label).join(', ') : null,
      external_id:       t.id,
      external_source:   'hospitable',
    }))
}

/**
 * Resolves an IANA timezone identifier for a Hospitable property.
 *
 * Hospitable's prop.timezone field returns a UTC offset string (e.g. "-0500")
 * not an IANA identifier. Node's Intl API requires IANA identifiers for DST-aware
 * timezone math — passing a raw UTC offset produces wrong results across DST
 * transitions (e.g. a Chicago property's "-0500" offset is only correct half the
 * year; in winter it's UTC-6).
 *
 * Strategy: derive timezone from the property's US state. State is stable, reliable,
 * and covers 99%+ of the US STR market without a geocoding API dependency.
 *
 * @param hospTimezone  Raw timezone value from Hospitable API (e.g. "-0500") —
 *                      intentionally not used; parameter exists for documentation
 * @param state         Two-letter US state code from the property address (e.g. "AL")
 * @returns             IANA timezone string safe for use with Intl.DateTimeFormat
 */
export function resolveHospitableTimezone(
  hospTimezone: string | null | undefined,
  state:        string | null | undefined
): string {
  const STATE_TIMEZONE: Record<string, string> = {
    // Eastern (UTC-5/UTC-4 DST)
    CT: 'America/New_York',  DE: 'America/New_York',  FL: 'America/New_York',
    GA: 'America/New_York',  MA: 'America/New_York',  MD: 'America/New_York',
    ME: 'America/New_York',  MI: 'America/Detroit',   NC: 'America/New_York',
    NH: 'America/New_York',  NJ: 'America/New_York',  NY: 'America/New_York',
    OH: 'America/New_York',  PA: 'America/New_York',  RI: 'America/New_York',
    SC: 'America/New_York',  VA: 'America/New_York',  VT: 'America/New_York',
    WV: 'America/New_York',
    // Indiana splits — use Indianapolis as the dominant zone
    IN: 'America/Indiana/Indianapolis',
    // Central (UTC-6/UTC-5 DST)
    AL: 'America/Chicago',   AR: 'America/Chicago',   IA: 'America/Chicago',
    IL: 'America/Chicago',   KS: 'America/Chicago',   KY: 'America/Chicago',
    LA: 'America/Chicago',   MN: 'America/Chicago',   MO: 'America/Chicago',
    MS: 'America/Chicago',   ND: 'America/Chicago',   NE: 'America/Chicago',
    OK: 'America/Chicago',   SD: 'America/Chicago',   TN: 'America/Chicago',
    TX: 'America/Chicago',   WI: 'America/Chicago',
    // Mountain (UTC-7/UTC-6 DST)
    CO: 'America/Denver',    MT: 'America/Denver',    NM: 'America/Denver',
    UT: 'America/Denver',    WY: 'America/Denver',
    // Mountain no-DST
    AZ: 'America/Phoenix',
    // Pacific (UTC-8/UTC-7 DST)
    CA: 'America/Los_Angeles', NV: 'America/Los_Angeles',
    OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
    // Non-contiguous
    AK: 'America/Anchorage',
    HI: 'Pacific/Honolulu',
    // Idaho splits — Boise (south) is most common for STR market
    ID: 'America/Boise',
  }

  const normalized = state?.trim().toUpperCase()
  if (normalized && STATE_TIMEZONE[normalized]) {
    return STATE_TIMEZONE[normalized]!
  }

  // Fallback — Central is the most common timezone in the US STR market
  // and is preferable to Eastern as a generic default for unknown states
  return 'America/Chicago'
}

// ── Utility ───────────────────────────────────────────────────────────────────

// Extracts "HH:MM" from a Hospitable ISO datetime string
// (e.g. "2019-01-03T13:00:00-05:00" → "13:00"). Falls back when
// the field is missing or doesn't match the expected shape.
export function extractHospitableTime(
  isoDatetime: string | null | undefined,
  fallback:    string
): string {
  const match = isoDatetime?.match(/T(\d{2}:\d{2})/)
  return match?.[1] ?? fallback
}
