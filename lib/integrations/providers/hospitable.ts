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

import type { IntegrationProvider, TokenResponse } from '@/lib/integrations/types'

// ── Constants ────────────────────────────────────────────────────────────────

const HOSPITABLE_AUTHORIZE_URL = 'https://auth.hospitable.com/oauth/authorize'
const HOSPITABLE_TOKEN_URL     = 'https://auth.hospitable.com/oauth/token'
const HOSPITABLE_API_BASE      = 'https://public.api.hospitable.com/v2'

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
  address:       HospitableAddress
  timezone:      string
  listed:        boolean
  capacity: {
    max:      number | null
    bedrooms: number | null
    beds:     number | null
  }
  room_details: Array<{ type: string; beds: Array<{ type: string; quantity: number }> }>
  'check-in':  string   // "HH:MM"
  'check-out': string   // "HH:MM"
  property_type: string
  room_type:     string
}

export interface HospitableReservationStatus {
  category:     'request' | 'accepted' | 'cancelled' | 'not accepted' | 'unknown' | 'checkpoint'
  sub_category: string
}

export interface HospitableGuest {
  first_name: string
  last_name:  string
  email:      string
  phone:      string | null
}

export interface HospitableReservation {
  id:                 string   // UUID
  platform:           string   // 'airbnb' | 'homeaway' | 'booking' | 'direct' | ...
  platform_id:        string   // Channel-native confirmation code
  arrival_date:       string   // YYYY-MM-DD
  departure_date:     string   // YYYY-MM-DD
  check_in:           string   // "HH:MM"
  check_out:          string   // "HH:MM"
  nights:             number
  reservation_status: { current: HospitableReservationStatus }
  guests:             { first_name?: string; last_name?: string } | HospitableGuest | null
  // Populated only when include=properties is passed
  properties?:        Array<{ id: string }>
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
  // IP range: 38.80.170.0/24
  async validateWebhook(request: Request): Promise<boolean> {
    const secret = process.env.HOSPITABLE_WEBHOOK_SECRET
    if (!secret) {
      console.error('[Hospitable] HOSPITABLE_WEBHOOK_SECRET not set — rejecting webhook')
      return false
    }

    const signatureHeader = request.headers.get('Signature')
    if (!signatureHeader) return false

    const body = await request.text()

    const { createHmac } = await import('crypto')
    const expected = createHmac('sha256', secret).update(body).digest('hex')

    return timingSafeEqual(signatureHeader, expected)
  },

  // Webhook payload: { id, action, data, created, version }
  // action 'reservation.changed' covers both create and update.
  // Webhooks are configured globally in the partner portal — no per-account registration.
  async handleWebhookEvent({ action, payload }) {
    const data = payload as Record<string, unknown>

    const entityData = (Array.isArray(data.data) ? data.data[0] : data.data) as Record<string, unknown> | undefined
    const entityId   = entityData?.id as string | undefined

    switch (action) {
      case 'reservation.changed': {
        if (!entityId) {
          console.warn('[Hospitable webhook] reservation.changed missing data.id:', data)
          break
        }
        const { inngest } = await import('@/lib/inngest/client')
        await inngest.send({
          name: 'integration/hospitable.sync.requested',
          data: {
            provider_id:  'hospitable',
            event_type:   action,
            entity_type:  'reservation',
            entity_id:    entityId,
            triggered_at: new Date().toISOString(),
          },
        })
        break
      }

      case 'property.changed':
      case 'property.created':
      case 'property.updated':
      case 'property.deleted':
      case 'property.merged': {
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

export async function hospFetchProperties(token: string): Promise<HospitableProperty[]> {
  const properties: HospitableProperty[] = []
  const PER_PAGE  = 100
  const MAX_PAGES = 200

  let url: string | null = `${HOSPITABLE_API_BASE}/properties?per_page=${PER_PAGE}`
  let pageCount = 0

  while (url) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      console.error(`[Hospitable] properties pagination exceeded ${MAX_PAGES} pages — aborting`)
      break
    }

    const res = await fetch(url, { headers: hospitableProvider.getApiHeaders(token) })

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

export async function hospFetchReservations(
  token: string,
  since?: string,
  propertyIds?: string[]
): Promise<HospitableReservation[]> {
  const reservations: HospitableReservation[] = []
  const PER_PAGE  = 100
  const MAX_PAGES = 200

  const startDate = since
    ?? new Date(Date.now() - 90 * 86_400_000).toISOString().split('T')[0]

  let page      = 1
  let lastPage  = 1
  let pageCount = 0

  while (page <= lastPage) {
    pageCount++
    if (pageCount > MAX_PAGES) {
      console.error(`[Hospitable] reservations pagination exceeded ${MAX_PAGES} pages — aborting`)
      break
    }

    const params = new URLSearchParams({
      page:       String(page),
      per_page:   String(PER_PAGE),
      start_date: startDate,
      include:    'guest,properties',
      date_query: 'checkin',
    })

    if (propertyIds?.length) {
      params.set('properties', propertyIds.join(','))
    }

    const res = await fetch(`${HOSPITABLE_API_BASE}/reservations?${params}`, {
      headers: hospitableProvider.getApiHeaders(token),
    })

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

// ── Status mapping ────────────────────────────────────────────────────────────

export function mapHospitableStatus(
  category: HospitableReservationStatus['category']
): 'confirmed' | 'tentative' | 'cancelled' {
  switch (category) {
    case 'accepted':     return 'confirmed'
    case 'request':      return 'tentative'
    case 'cancelled':
    case 'not accepted': return 'cancelled'
    default:             return 'confirmed'
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

// ── Utility ───────────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}
