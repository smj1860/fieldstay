// lib/integrations/providers/hostaway.ts
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

  async validateWebhook(): Promise<boolean> {
    // Hostaway unified webhooks use HMAC-SHA256 signature verification.
    // The signing secret is set when registering the webhook endpoint.
    // Implement when webhook support is added — for now reject all inbound
    // webhooks since there is no registered endpoint or secret to verify yet.
    return false
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

  while (true) {
    const res = await fetch(
      `${BASE_URL}/listings?limit=${LIMIT}&offset=${offset}&includeResources=0`,
      { headers: hostawayProvider.getApiHeaders(token) }
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

  const fromDate = since
    ?? new Date(Date.now() - 90 * 86_400_000).toISOString().split('T')[0]

  while (true) {
    const params = new URLSearchParams({
      limit:     String(LIMIT),
      offset:    String(offset),
      sortOrder: 'arrivalDate',
      dateFrom:  fromDate!,
    })

    const res = await fetch(`${BASE_URL}/reservations?${params}`, {
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
