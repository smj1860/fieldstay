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

import { RateLimitError, IntegrationMisconfiguredError, type IntegrationProvider, type TokenResponse } from '@/lib/integrations/types'
import { storeHospitableWebhookMessage, type HospitableWebhookMessage } from '@/lib/integrations/providers/hospitable-message-store'
import { hospitableApiLimiter, checkLimit, outboundBackoffSeconds } from '@/lib/rate-limit'
import { ok, fail, timingSafeEqual, extractClientIp, isIpInCidr } from '@/lib/integrations/webhook-verification'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { reportError } from '@/lib/observability/report-error'
import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'
import type {
  HospitableUser,
  HospitableProperty,
  HospitablePagedProperties,
  HospitableReservation,
  HospitablePagedReservations,
  HospitableReview,
  HospitablePagedReviews,
  HospitableCalendarDay,
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
      throw new IntegrationMisconfiguredError('Missing HOSPITABLE_CLIENT_ID or HOSPITABLE_CLIENT_SECRET')
    }

    const response = await fetch(HOSPITABLE_TOKEN_URL, {
      signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
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
      throw new IntegrationMisconfiguredError('Missing HOSPITABLE_CLIENT_ID or HOSPITABLE_CLIENT_SECRET')
    }

    const response = await fetch(HOSPITABLE_TOKEN_URL, {
      signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
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
  // top-level payload `id` is NEVER the reservation's own id, though — it's
  // the webhook DELIVERY's own id (confirmed via two independent live
  // captures across two event types: a property.changed delivery and a
  // reservation.changed delivery both had top-level id ≠ the entity's real
  // id). Falling back to it (as this used to) sends a GET for the wrong
  // reservation, gets a 404, and the missing-reservation branch in
  // incremental-sync.ts silently treats that as a cancellation — discarding
  // every real partial update (date changes, checkout-time changes, real
  // cancellations) on an already-synced reservation. Do NOT reintroduce a
  // `?? data.id` fallback here.
  async handleWebhookEvent({ action, payload }) {
    const data = payload as Record<string, unknown>

    const entityData = unwrapJoin(data.data as Record<string, unknown> | Record<string, unknown>[] | null | undefined) ?? undefined
    const entityId   = entityData?.id as string | undefined

    // The connected account's own user id — confirmed present on live
    // webhook payloads as data.user.id. This is the SAME value stored as
    // integration_connections.external_user_id at OAuth-connect time (see
    // exchangeCodeForToken below: externalUserId: user.id), so it lets
    // resolveHospitableOwner() attribute the entity directly rather than
    // falling to its cache/local-table/probe chain. Not confirmed present
    // on every payload shape (message.created's shape is itself unconfirmed
    // — see the case below), so this is threaded through as optional.
    const webhookUser     = entityData?.user as { id?: string } | undefined
    const externalUserId  = webhookUser?.id

    switch (action) {
      case 'reservation.created':
      case 'reservation.changed': {
        // entityId comes from data.data.id — only reliably present on
        // reservation.created (which may send the fuller object). A partial
        // reservation.changed payload has NO id anywhere that identifies the
        // reservation: data.data has no `id` field, and the top-level `id` is
        // the webhook DELIVERY's own id, not the reservation's id (see the
        // header comment above). With no identifiable id in the payload,
        // there is no way to know which reservation changed — drop it
        // loudly rather than guessing with a 404-then-fake-cancel.
        const reservationId = entityId
        if (!reservationId) {
          console.warn(
            '[Hospitable webhook] reservation.changed has no resolvable id ' +
            '(data.data.id absent — partial payload). Dropping; entity cannot ' +
            'be identified from this payload alone.',
            { action, keys: Object.keys(data) },
          )
          reportError(
            new Error('Unresolvable reservation.changed payload — no data.data.id'),
            { site: 'lib.integrations.providers.hospitable.handleWebhookEvent', extra: { action } },
          )
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
            external_user_id: externalUserId,
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
            external_user_id: externalUserId,
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
            external_user_id:     externalUserId,
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
            external_user_id: externalUserId,
            triggered_at: new Date().toISOString(),
          },
        })
        break
      }

      // Stored INLINE from the payload, with no fetch and no Inngest hop.
      //
      // A real payload captured 2026-08-20 settled the "unconfirmed shape"
      // this case used to hedge against, and settled it the other way: the
      // webhook carries the WHOLE message — body, sender, created_at,
      // conversation_id, platform, content_type, attachments — so
      // GET /reservations/{uuid}/messages was re-requesting data already in
      // hand. That fetch is what 400'd (`data.id` is the numeric MESSAGE id,
      // not a reservation), and `reservation_id` is legitimately null on a
      // pre-booking inquiry, so the old design could never store an inquiry
      // at all. See lib/integrations/providers/hospitable-message-store.ts.
      case 'message.created':
      case 'message.updated': {
        const outcome = await storeHospitableWebhookMessage(
          (entityData ?? {}) as HospitableWebhookMessage,
          action,
        )
        if (!outcome.stored) {
          console.warn(`[Hospitable webhook] ${action} not stored: ${outcome.reason}`)
        }
        break
      }

      case 'integration.disconnected':
      case 'integration_disconnected':
      case 'application_authorization_revoked':
        // All three are Hospitable's revocation event names — handled upstream by
        // the generic webhook route's REVOCATION_ACTIONS check via revokeIntegrationToken().
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
 * layers apply uniformly.
 *
 * ⚠️ The proactive budget CANNOT prevent every 429, and production proved it
 * on 2026-08-17: Hospitable's partner API log showed a real 429 on
 * GET /v2/reservations/{uuid} bracketed by 200s nine seconds either side,
 * while the platform-wide 54/60 budget was nowhere near spent. Hospitable
 * enforces PER-ENTITY limits far tighter than the general one (the messages
 * endpoint is documented at 2 req/min per reservation), and a platform-wide
 * counter is structurally blind to those. The reactive branch below is
 * therefore the load-bearing one, not the fallback — which is why callers must
 * honour its retryAfter rather than leaving it to Inngest's generic backoff.
 */
export async function hospitableFetch(url: string, token: string): Promise<Response> {
  // Outbound quota against Hospitable's own 60/min ceiling → fails CLOSED:
  // this exists so we throw RateLimitError before Hospitable 429s us. If the
  // budget check itself is unavailable we must not blow through their limit.
  const budget = await checkLimit(hospitableApiLimiter, 'hospitable-api', {
    onError: 'deny',
    site:    'lib.integrations.hospitable.hospitableFetch',
  })
  if (!budget.allowed) {
    // Jittered, and a real backoff rather than ~1s when the limiter itself
    // errored — see outboundBackoffSeconds' doc comment for both.
    throw new RateLimitError(outboundBackoffSeconds(budget))
  }

  const res = await fetch(url, { headers: hospitableProvider.getApiHeaders(token), signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS) })

  if (res.status === 429) {
    throw new RateLimitError(parseRetryAfterSeconds(res.headers.get('Retry-After')))
  }

  return res
}

/**
 * Retry-After → whole seconds, floored at 1.
 *
 * RFC 7231 permits BOTH `delay-seconds` and an HTTP-date, and a bare
 * parseInt() on the date form yields NaN. That NaN reached RateLimitError's
 * message as "retry after NaNs" and would reach step.sleep() as the duration
 * string `NaNs`, which Inngest cannot parse — turning a routine throttle into
 * a hard function failure. Both forms are handled here, and anything
 * unparseable falls back to the same 60s an absent header gets.
 */
export function parseRetryAfterSeconds(header: string | null): number {
  if (!header) return 60

  const trimmed = header.trim()

  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds))

  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) return Math.max(1, Math.ceil((dateMs - Date.now()) / 1000))

  return 60
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
      // THROW rather than break. `break` returned the pages gathered so far as
      // if they were the complete set, and callers upsert that list and treat
      // anything missing from it as gone — the same silent-truncation class as
      // the OwnerRez pager. A loud failure is strictly better than a quietly
      // short portfolio.
      throw new Error(
        `[Hospitable] properties pagination exceeded ${MAX_PAGES} pages ` +
        `(${properties.length} so far) — refusing to return a partial result`
      )
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

/**
 * Enumerates the start_date windows hospFetchReservations() would iterate.
 *
 * Exported so hospInitialSync can run ONE Inngest step per window instead of
 * wrapping the whole ~26-window loop in a single step. Under the shared
 * hospitableApiLimiter budget, a rate-limit throw mid-loop previously restarted
 * the entire fetch from window 1, re-spending budget it had already consumed
 * and burning the function's retry allowance on work it had already done.
 */
export function hospReservationWindows(
  since?:          string,
  lookaheadMonths: number = RESERVATION_LOOKAHEAD_MONTHS,
): string[] {
  const rangeStart = since
    ? new Date(`${since}T00:00:00Z`)
    : new Date(Date.now() - RESERVATION_WINDOW_DAYS * 86_400_000)

  const rangeEnd = new Date(rangeStart)
  rangeEnd.setUTCMonth(rangeEnd.getUTCMonth() + lookaheadMonths)

  const windows: string[] = []
  for (
    let windowStart = rangeStart;
    windowStart < rangeEnd;
    windowStart = new Date(windowStart.getTime() + RESERVATION_WINDOW_DAYS * 86_400_000)
  ) {
    windows.push(windowStart.toISOString().split('T')[0]!)
  }

  return windows
}

// Single start_date window, fully paginated. See RESERVATION_WINDOW_DAYS'
// doc comment above for why hospFetchReservations() calls this in a loop
// rather than once with one big range.
//
// Exported (was module-private) so hospInitialSync can drive the loop from
// Inngest steps — see hospReservationWindows() above.
export async function fetchReservationsWindow(
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
      throw new Error(
        `[Hospitable] reservations pagination exceeded ${MAX_PAGES} pages ` +
        `(${reservations.length} so far) — refusing to return a partial result`
      )
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

// GET /properties/{uuid}/reviews — ✅ confirmed live 2026-07-15 against a
// real response (5 real reviews returned for a real property): reviews are
// fetched per-property, NOT via a flat /reviews?properties[]=... collection
// (an earlier version of this function assumed the latter and 404'd on
// first live try). per_page maxes at 50 (not the 100 used elsewhere in this
// file) — Hospitable's own docs cap it there for this endpoint specifically.
//
// Used for the one-time historical backfill (see
// hospitable/hospitable-reviews-backfill.ts) — ongoing new/changed reviews
// arrive via the review.created/review.changed webhook instead
// (incremental-sync.ts), which fetches one review at a time by id and
// doesn't go through this function at all.
export async function hospFetchReviews(
  token:      string,
  propertyId: string
): Promise<HospitableReview[]> {
  const reviews: HospitableReview[] = []
  const PER_PAGE  = 50
  const MAX_PAGES = 200

  let url: string | null =
    `${HOSPITABLE_API_BASE}/properties/${propertyId}/reviews?per_page=${PER_PAGE}&include=guest`
  let pageCount = 0

  while (url) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      throw new Error(
        `[Hospitable] reviews pagination exceeded ${MAX_PAGES} pages for property ${propertyId} ` +
        `(${reviews.length} so far) — refusing to return a partial result`
      )
    }

    const res = await hospitableFetch(url, token)

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Hospitable /properties/${propertyId}/reviews failed (${res.status}): ${text.slice(0, 200)}`)
    }

    const data = await res.json() as HospitablePagedReviews
    reviews.push(...(data.data ?? []))
    url = data.links?.next ?? null
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
      throw new Error(
        `[Hospitable] teammates pagination exceeded ${MAX_PAGES} pages ` +
        `(${teammates.length} so far) — refusing to return a partial result`
      )
    }

    const res = await hospitableFetch(url, token)

    if (!res.ok) {
      const text = await res.text().catch(() => '')

      // 403 is the ONE expected non-ok: a connection predating the
      // teammate:read scope. Nothing is retriable about it, and teammate sync
      // is additive, so an empty list is the honest answer. Callers that
      // reconcile by absence must still guard an empty set — see
      // teammate-sync-handler's deactivation pass.
      if (res.status === 403) {
        console.warn(
          `[Hospitable] GET /teammates forbidden (missing teammate:read scope): ${text.slice(0, 200)}`
        )
        return []
      }

      // Everything else THROWS. This returned [] for any status at all, from
      // inside the pagination loop — so a 500 on page two discarded page one
      // as well and reported "0 teammates" as a successful sync. Combined with
      // the caller's absence-based deactivation, that is how an org's entire
      // Hospitable crew roster was deactivated in one run.
      throw new Error(
        `[Hospitable] GET /teammates failed (${res.status}): ${text.slice(0, 200)}`
      )
    }

    const data = await res.json() as HospitablePagedTeammates
    teammates.push(...(data.data ?? []))
    url = data.links?.next ?? null
  }

  return teammates
}
