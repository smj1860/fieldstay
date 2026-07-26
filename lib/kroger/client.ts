// lib/kroger/client.ts
// Place at: lib/kroger/client.ts

import type { Ratelimit } from '@upstash/ratelimit'
import {
  krogerAuthApiLimiter,
  krogerProductsApiLimiter,
  krogerLocationsApiLimiter,
  krogerCartApiLimiter,
} from '@/lib/rate-limit'
import { RateLimitError } from '@/lib/integrations/types'
import type {
  KrogerTokenResponse,
  KrogerProductSearchResponse,
  KrogerProduct,
  KrogerLocation,
  KrogerCartItem,
} from './types'

const KROGER_API_BASE  = 'https://api.kroger.com/v1'
const KROGER_AUTH_BASE = 'https://api.kroger.com/v1/connect/oauth2'

// ── Rate limiting ────────────────────────────────────────────────
//
// Every outbound Kroger call in this file goes through krogerFetch instead
// of calling fetch() directly, so the shared platform-wide budget (see
// lib/rate-limit.ts — one app-level Kroger client credential, not a
// per-org allocation, same rationale as hospitableFetch in
// lib/integrations/providers/hospitable.ts and OwnerRez's per-IP tracker
// in lib/integrations/providers/ownerrez-api.ts) is enforced uniformly:
//
//   1. Proactively check the relevant endpoint-class limiter BEFORE the
//      call. Throws RateLimitError before Kroger would actually 429 us.
//   2. If Kroger 429s anyway, parse Retry-After and throw RateLimitError
//      with that exact wait time.
//
// Fails OPEN if the limiter check itself errors (Redis unavailable) —
// this is an abuse/external-quota limiter guarding Kroger's own rate
// limit, not a spend-budget limiter (see
// docs/SCALABILITY_TIERS_REMAINING.md item 4, which reserves fail-closed
// behavior for money-spending paths only). Matches proxy.ts's
// rateLimiterForPathname() convention: log and proceed rather than
// blocking every Kroger call over an infrastructure outage.
async function krogerFetch(
  limiter:    Ratelimit,
  identifier: string,
  input:      string,
  init:       RequestInit,
): Promise<Response> {
  try {
    const { success, reset } = await limiter.limit(identifier)
    if (!success) {
      const retryAfterSeconds = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
      throw new RateLimitError(retryAfterSeconds)
    }
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    // Redis unavailable or otherwise erroring — fail open. Don't block
    // every Kroger call over an infrastructure issue on our side.
    console.error('[Kroger] rate limit check failed — proceeding without it', err)
  }

  const res = await fetch(input, init)

  if (res.status === 429) {
    const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '60', 10)
    throw new RateLimitError(retryAfter)
  }

  return res
}

// ── Token Management ────────────────────────────────────────────

/**
 * Client credentials token — for product search and location lookup.
 * Does not require customer authentication.
 * Tokens expire in 30 minutes; call at the start of each Inngest step.
 */
export async function getClientToken(): Promise<string> {
  const clientId     = process.env.KROGER_CLIENT_ID
  const clientSecret = process.env.KROGER_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('KROGER_CLIENT_ID or KROGER_CLIENT_SECRET not set')
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const res = await krogerFetch(krogerAuthApiLimiter, 'kroger-auth', `${KROGER_AUTH_BASE}/token`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope:      'product.compact',
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Kroger client token request failed ${res.status}: ${body}`)
  }

  const data = (await res.json()) as KrogerTokenResponse
  return data.access_token
}

/**
 * Exchange authorization code for customer tokens (cart.basic:write scope).
 * Called from the OAuth callback route after PM authorizes.
 */
export async function exchangeCodeForCustomerToken(
  code:        string,
  redirectUri: string,
): Promise<KrogerTokenResponse> {
  const clientId     = process.env.KROGER_CLIENT_ID!
  const clientSecret = process.env.KROGER_CLIENT_SECRET!
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const res = await krogerFetch(krogerAuthApiLimiter, 'kroger-auth', `${KROGER_AUTH_BASE}/token`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Kroger customer token exchange failed ${res.status}: ${body}`)
  }

  return (await res.json()) as KrogerTokenResponse
}

/**
 * Refresh a customer access token using their stored refresh token.
 */
export async function refreshCustomerToken(
  refreshToken: string,
): Promise<KrogerTokenResponse> {
  const clientId     = process.env.KROGER_CLIENT_ID!
  const clientSecret = process.env.KROGER_CLIENT_SECRET!
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const res = await krogerFetch(krogerAuthApiLimiter, 'kroger-auth', `${KROGER_AUTH_BASE}/token`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Kroger token refresh failed ${res.status}: ${body}`)
  }

  return (await res.json()) as KrogerTokenResponse
}

/**
 * Build the Kroger authorization URL for the PM OAuth connect flow.
 */
export function buildKrogerAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.KROGER_CLIENT_ID!,
    redirect_uri:  redirectUri,
    scope:         'cart.basic:write profile.compact',
    state,
  })
  return `${KROGER_AUTH_BASE}/authorize?${params.toString()}`
}

/**
 * Fetch the connected customer's Kroger profile ID.
 * Requires the `profile.compact` scope (included in buildKrogerAuthUrl).
 * Used as the externalUserId for the integration_connections row.
 */
export async function getKrogerProfile(
  customerToken: string,
): Promise<{ id: string } | null> {
  const res = await krogerFetch(krogerAuthApiLimiter, 'kroger-auth', `${KROGER_API_BASE}/identity/profile`, {
    headers: {
      'Authorization': `Bearer ${customerToken}`,
      'Accept':        'application/json',
    },
  })

  if (!res.ok) return null

  const data = (await res.json()) as { data?: { id?: string } }
  return data.data?.id ? { id: data.data.id } : null
}

// ── Products ────────────────────────────────────────────────────

export async function searchProducts(
  query:      string,
  locationId: string,
  token:      string,
  limit = 5,
): Promise<KrogerProduct[]> {
  const params = new URLSearchParams({
    'filter.term':        query,
    'filter.locationId':  locationId,
    'filter.limit':       String(limit),
    'filter.fulfillment': 'ais',
  })

  const res = await krogerFetch(
    krogerProductsApiLimiter,
    'kroger-products',
    `${KROGER_API_BASE}/products?${params.toString()}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    },
  )

  if (!res.ok) {
    console.error(`Kroger product search failed for "${query}": ${res.status}`)
    return []
  }

  const data = (await res.json()) as KrogerProductSearchResponse
  return data.data ?? []
}

// ── Locations ───────────────────────────────────────────────────

export async function findNearestKrogerStore(
  zipCode: string,
  token:   string,
): Promise<KrogerLocation | null> {
  const params = new URLSearchParams({
    'filter.zipCode.near':  zipCode,
    'filter.radiusInMiles': '35',
    'filter.limit':         '1',
  })

  const res = await krogerFetch(
    krogerLocationsApiLimiter,
    'kroger-locations',
    `${KROGER_API_BASE}/locations?${params.toString()}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    },
  )

  if (!res.ok) return null

  const data = (await res.json()) as { data: KrogerLocation[] }
  return data.data?.[0] ?? null
}

// ── Cart ────────────────────────────────────────────────────────

/**
 * Add items to the customer's Kroger cart.
 * Requires a customer OAuth token (cart.basic:write scope).
 */
export async function addItemsToKrogerCart(
  items:         KrogerCartItem[],
  customerToken: string,
): Promise<boolean> {
  if (!items.length) return true

  const res = await krogerFetch(krogerCartApiLimiter, 'kroger-cart', `${KROGER_API_BASE}/cart/add`, {
    method:  'PUT',
    headers: {
      'Authorization': `Bearer ${customerToken}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify({ items }),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error(`Kroger cart add failed ${res.status}: ${body}`)
    return false
  }

  return true
}

// ── Helpers ─────────────────────────────────────────────────────

export function getBestProductImage(product: KrogerProduct): string | undefined {
  const front  = product.images?.find(i => i.perspective === 'front')
  const images = front?.sizes ?? product.images?.[0]?.sizes ?? []
  const medium = images.find(s => s.size === 'medium')
  return (medium ?? images[0])?.url
}

export function getBestPrice(product: KrogerProduct): number | undefined {
  const item = product.items?.[0]
  if (!item?.price) return undefined
  return item.price.promo ?? item.price.regular
}
