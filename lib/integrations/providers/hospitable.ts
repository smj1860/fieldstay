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
//
// Type definitions live in hospitable.types.ts and pure raw -> normalized
// mapping functions live in hospitable.mappers.ts — both re-exported below
// so every existing import from '@/lib/integrations/providers/hospitable'
// keeps working unchanged.
// ============================================================

import { RateLimitError, type IntegrationProvider, type TokenResponse } from '@/lib/integrations/types'
import { hospitableApiLimiter } from '@/lib/rate-limit'
import { ok, fail, timingSafeEqual, extractClientIp, isIpInCidr } from '@/lib/integrations/webhook-verification'
import type {
  HospitableUser,
  HospitableProperty,
  HospitablePagedProperties,
  HospitableReservation,
  HospitablePagedReservations,
  HospitableReview,
  HospitablePagedReviews,
  HospitableCalendarDay,
  HospitableMessage,
  HospitablePagedMessages,
  HospitableTeammate,
  HospitablePagedTeammates,
} from './hospitable.types'

export * from './hospitable.types'
export * from './hospitable.mappers'

// ── Constants ────────────────────────────────────────────────────────────────

const HOSPITABLE_AUTHORIZE_URL = 'https://auth.hospitable.com/oauth/authorize'
const HOSPITABLE_TOKEN_URL     = 'https://auth.hospitable.com/oauth/token'
const HOSPITABLE_API_BASE      = 'https://public.api.hospitable.com/v2'

// Hospitable's own webhook docs advise whitelisting only this range.
// Defense-in-depth alongside the HMAC signature check below, which remains
// the primary control — an out-of-range request is rejected before it's
// worth spending a crypto comparison on.
const HOSPITABLE_WEBHOOK_IP_CIDR = '38.80.170.0/24'

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
          console.warn('[Hospitable webhook] reservation event missing id (checked data.id and payload.id):', { action, keys: Object.keys(data) })
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
          console.warn('[Hospitable webhook] property event missing data.id:', { action, keys: Object.keys(data) })
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
          console.warn('[Hospitable webhook] property.merged missing previous_id/new_id:', { action, keys: Object.keys(data) })
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
          console.warn('[Hospitable webhook] review event missing data.id:', { action, keys: Object.keys(data) })
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
          console.warn('[Hospitable webhook] message event missing reservation_id (checked data.reservation_id, data.id, payload.id):', { action, keys: Object.keys(data) })
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

// GET /reviews — requires properties[] (REQUIRED per api-reference.md; no
// account-wide "all reviews" mode exists). Used for the one-time historical
// backfill (see hospitable/hospitable-reviews-backfill.ts) — ongoing new/
// changed reviews arrive via the review.created/review.changed webhook
// instead (incremental-sync.ts), which fetches one review at a time and
// doesn't go through this function at all.
//
// propertyIds is chunked to keep the properties[] query string from growing
// unbounded for a large portfolio; each chunk is paginated independently.
export async function hospFetchReviews(
  token:       string,
  propertyIds: string[]
): Promise<HospitableReview[]> {
  if (propertyIds.length === 0) return []

  const reviews: HospitableReview[] = []
  const PER_PAGE            = 100
  const MAX_PAGES           = 200
  const PROPERTY_CHUNK_SIZE = 25

  for (let i = 0; i < propertyIds.length; i += PROPERTY_CHUNK_SIZE) {
    const chunk = propertyIds.slice(i, i + PROPERTY_CHUNK_SIZE)

    // properties[] must use literal brackets — URLSearchParams encodes []
    // as %5B%5D, which Hospitable does not accept (same constraint as
    // fetchReservationsWindow above). Each id is still percent-encoded
    // individually so a malformed value can't inject extra query params.
    const propertiesQuery = chunk
      .map((id) => `properties[]=${encodeURIComponent(id)}`)
      .join('&')

    let page      = 1
    let lastPage  = 1
    let pageCount = 0

    while (page <= lastPage) {
      pageCount++
      if (pageCount > MAX_PAGES) {
        console.error('[Hospitable] reviews pagination exceeded max pages — aborting chunk')
        break
      }

      const params = new URLSearchParams({
        page:     String(page),
        per_page: String(PER_PAGE),
        include:  'guest,reservation',
      })

      const url = `${HOSPITABLE_API_BASE}/reviews?${params.toString()}&${propertiesQuery}`
      const res = await hospitableFetch(url, token)

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Hospitable /reviews failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as HospitablePagedReviews
      reviews.push(...(data.data ?? []))

      lastPage = data.meta?.last_page ?? page
      page++
    }
  }

  return reviews
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
