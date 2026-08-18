// lib/integrations/providers/hostaway.ts
// ============================================================
// LIVE since 2026-08-17. This header said "DISABLED — not ready for launch
// (product decision, 2026-07-25)" and listed the four places that made it
// unreachable; all four are now wired. Left as a note rather than deleted
// because the disable comments elsewhere pointed here.
// ============================================================
// Hostaway API-key provider adapter.
//
// Hostaway specifics:
//   - No browser-redirect OAuth — PM enters Account ID + API Key in a
//     credential modal, which is exchanged once for a long-lived Bearer token.
//   - Token validity ~6 months (15,897,600s). No refresh token to manage.
//   - All list responses are wrapped in { status, result: [...] }.
// ============================================================

import type { IntegrationProvider } from '@/lib/integrations/types'
import { fail } from '@/lib/integrations/webhook-verification'
import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'

// Exact field names from Hostaway API GET /v1/listings response
export interface HostawayListing {
  id:                   number
  name:                 string     // internal name
  externalListingName?: string     // guest-facing name (prefer this)
  address?:             string
  city?:                string
  state?:               string
  zipcode?:             string
  country?:             string
  countryCode?:         string
  bedrooms?:            number
  bathrooms?:           number
  maxGuests?:           number
  price?:               number
  lat?:                 number
  lng?:                 number
}

// Exact field names from Hostaway API GET /v1/reservations response
export interface HostawayReservation {
  id:             number
  listingId:      number
  guestName?:     string
  guestEmail?:    string
  phone?:         string
  arrivalDate:    string  // YYYY-MM-DD
  departureDate:  string  // YYYY-MM-DD
  status:         'new' | 'modified' | 'cancelled' | 'confirmed' | 'inquiry' | 'tentative'
  channelName?:   string  // 'airbnb', 'vrbo', 'booking.com', 'direct', etc.
  totalPrice?:    number
  currency?:      string
  adults?:        number
  children?:      number
  createdAt?:     string
  updatedAt?:     string
}

// Exact field names from Hostaway API GET /v1/reviews response.
export interface HostawayReview {
  id:               number
  accountId?:       number
  /**
   * The listing this review is about.
   *
   * NOTE the name: reviews say `listingMapId` where GET /reservations says
   * `listingId`. Both identify the same listing — Hostaway is inconsistent
   * across endpoints, not describing two different things — and both are
   * matched against `properties.external_id`, which the initial sync writes
   * from `HostawayListing.id`.
   */
  listingMapId:     number
  reservationId?:   number | null
  channelId?:       number | null
  /** 'guest-to-host' is a review OF us; 'host-to-guest' is one BY us. */
  type:             'guest-to-host' | 'host-to-guest'
  status:           'awaiting' | 'pending' | 'scheduled' | 'submitted' | 'published' | 'expired'
  rating:           number | null
  /** The review body. Null until the guest actually submits one. */
  publicReview:     string | null
  privateFeedback?: string | null
  /** The host's reply, when one has been posted. */
  revieweeResponse: string | null
  isCancelled?:     number | null
  /** 'YYYY-MM-DD HH:MM:SS', no timezone offset. */
  departureDate:    string | null
  arrivalDate?:     string | null
  listingName?:     string | null
  guestName:        string | null
}

const BASE_URL = 'https://api.hostaway.com/v1'

export const hostawayProvider: IntegrationProvider = {
  id:          'hostaway',
  displayName: 'Hostaway',
  authType:    'api_key',

  getApiHeaders(token: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    }
  },

  async validateWebhook() {
    // CORRECTION (2026-08-17, checked against api.hostaway.com/documentation):
    // this comment used to say "Hostaway unified webhooks use HMAC-SHA256
    // signature verification, the signing secret is set when registering the
    // endpoint". That is WRONG, and it was load-bearing wrong — it is what
    // docs/HOSTAWAY_ENABLEMENT.md sized the webhook phase against.
    //
    // Hostaway's unified webhook registration takes URL (mandatory) plus
    // Login and Password (optional), and deliveries carry them in the request's
    // authentication header. So it is HTTP Basic Auth with credentials WE
    // choose at registration — the same model OwnerRez uses, which means
    // ownerRezProvider.validateWebhook is the template (constant-time compare
    // of a user/pass pair from env, plus an optional source-IP allowlist), and
    // the per-connection-secret column that phase was scoped to need does not
    // exist. One platform-wide HOSTAWAY_WEBHOOK_USER/PASSWORD covers every
    // tenant, because we supply the same pair on every registration.
    //
    // Still rejecting everything until that lands: no endpoint is registered
    // with Hostaway, so any delivery arriving here is unsolicited.
    return fail('no webhook endpoint registered with Hostaway yet')
  },

  async handleWebhookEvent({ action, payload }) {
    // Hostaway sends reservation.created, reservation.modified,
    // reservation.cancelled events. Wire to incremental sync in a future phase.
    console.log('[Hostaway] webhook received:', action, typeof payload)
  },
}

// ── Hostaway-specific API helpers ──────────────────────────────────────────

/**
 * Exchange an Account ID + API Key for a Bearer access token.
 * Called once during connect. Token is stored in Vault.
 * Token validity: ~6 months (15,897,600 seconds).
 */
export async function hostawayExchangeCredentials(
  accountId: string,
  apiKey:    string
): Promise<{ accessToken: string; expiresAt: string; externalUserId: string }> {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     accountId,
    client_secret: apiKey,
    scope:         'general',
  })

  const res = await fetch(`${BASE_URL}/accessTokens`, {
    signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => 'no body')
    throw new Error(`Hostaway token exchange failed (${res.status}): ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    access_token: string
    expires_in:   number
    token_type:   string
  }

  if (!data.access_token) {
    throw new Error('Hostaway returned no access_token')
  }

  const expiresAt = new Date(
    Date.now() + (data.expires_in ?? 15_897_600) * 1000
  ).toISOString()

  return {
    accessToken:    data.access_token,
    expiresAt,
    externalUserId: accountId,  // Use accountId as the stable external identifier
  }
}

/**
 * Fetch all listings (properties) from Hostaway with pagination.
 */
export async function hostawayFetchListings(
  token: string
): Promise<HostawayListing[]> {
  const listings: HostawayListing[] = []
  const LIMIT = 100
  let offset  = 0
  let pageCount = 0
  const MAX_PAGES = 200

  while (true) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      // THROW rather than break — see the note on hospFetchProperties. A
      // partial listing set returned as complete is indistinguishable from a
      // shrunken portfolio to everything downstream.
      throw new Error(
        `[Hostaway] listings pagination exceeded ${MAX_PAGES} pages ` +
        `(${listings.length} so far) — refusing to return a partial result`
      )
    }

    const res = await fetch(
      `${BASE_URL}/listings?limit=${LIMIT}&offset=${offset}&includeResources=0`,
      { headers: hostawayProvider.getApiHeaders(token), signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS) }
    )

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Hostaway listings fetch failed (${res.status}): ${text.slice(0, 200)}`)
    }

    const data = (await res.json()) as { status: string; result: HostawayListing[] }
    const page = data.result ?? []

    listings.push(...page)
    if (page.length < LIMIT) break
    offset += LIMIT
  }

  return listings
}

/**
 * Fetch all reservations from Hostaway with pagination.
 * Fetches from 90 days ago through far future to capture recent history.
 */
export async function hostawayFetchReservations(
  token: string,
  since?: string   // ISO date string — for incremental sync
): Promise<HostawayReservation[]> {
  const reservations: HostawayReservation[] = []
  const LIMIT  = 100
  let   offset = 0
  let pageCount = 0
  const MAX_PAGES = 200

  const fromDate = since
    ?? new Date(Date.now() - 90 * 86_400_000).toISOString().split('T')[0]

  while (true) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      throw new Error(
        `[Hostaway] reservations pagination exceeded ${MAX_PAGES} pages ` +
        `(${reservations.length} so far) — refusing to return a partial result`
      )
    }

    const params = new URLSearchParams({
      limit:     String(LIMIT),
      offset:    String(offset),
      sortOrder: 'arrivalDate',
      dateFrom:  fromDate!,
    })

    const res = await fetch(`${BASE_URL}/reservations?${params}`, {
      signal: AbortSignal.timeout(PMS_API_TIMEOUT_MS),
      headers: hostawayProvider.getApiHeaders(token),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Hostaway reservations fetch failed (${res.status}): ${text.slice(0, 200)}`)
    }

    const data = (await res.json()) as { status: string; result: HostawayReservation[] }
    const page = data.result ?? []

    reservations.push(...page)
    if (page.length < LIMIT) break
    offset += LIMIT
  }

  return reservations
}

/**
 * Fetch reviews, paginated.
 *
 * `type=guest-to-host` is applied SERVER-side, and it is not an optimisation:
 * the other direction is us reviewing the guest. Importing those would put our
 * own words in the reviews table and hand RepuGuard our review to draft a
 * reply to.
 *
 * Status is deliberately NOT filtered server-side even though the endpoint
 * accepts `statuses[]`. `reviews.rating` and `reviews.review_text` are both
 * NOT NULL, so what actually matters is whether a review HAS a rating and a
 * body — and that is a property of the row, not reliably of its status name.
 * The mapper drops the ones that don't; guessing which statuses carry content
 * would fail silently the first time Hostaway added one.
 *
 * @param since 'YYYY-MM-DD' — lower bound on departureDate.
 */
export async function hostawayFetchReviews(
  token: string,
  since: string,
): Promise<HostawayReview[]> {
  const reviews: HostawayReview[] = []
  const LIMIT = 100
  let offset = 0
  let pageCount = 0
  const MAX_PAGES = 200

  while (true) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      // THROW rather than break — same reasoning as the listings and
      // reservations fetchers. A partial set returned as complete is
      // indistinguishable from a shrunken one to everything downstream.
      throw new Error(
        `[Hostaway] reviews pagination exceeded ${MAX_PAGES} pages ` +
        `(${reviews.length} so far) — refusing to return a partial result`
      )
    }

    const params = new URLSearchParams({
      limit:              String(LIMIT),
      offset:             String(offset),
      type:               'guest-to-host',
      departureDateStart: since,
      // Stable order across pages. Without it an offset walk over a set the
      // API is free to reorder can repeat and skip rows in the same sweep.
      sortBy:             'id',
      sortOrder:          'asc',
    })

    const res = await fetch(`${BASE_URL}/reviews?${params}`, {
      signal:  AbortSignal.timeout(PMS_API_TIMEOUT_MS),
      headers: hostawayProvider.getApiHeaders(token),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Hostaway reviews fetch failed (${res.status}): ${text.slice(0, 200)}`)
    }

    const data = (await res.json()) as { status: string; result: HostawayReview[] | null }
    const page = data.result ?? []

    reviews.push(...page)
    if (page.length < LIMIT) break
    offset += LIMIT
  }

  return reviews
}
