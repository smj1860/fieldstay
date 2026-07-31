// lib/kroger/client.ts
// Place at: lib/kroger/client.ts

import type { Ratelimit } from '@upstash/ratelimit'
import {
  krogerAuthApiLimiter,
  krogerProductsApiLimiter,
  krogerLocationsApiLimiter,
  krogerCartApiLimiter,
  checkLimit,
  retryAfterSeconds,
} from '@/lib/rate-limit'
import { RateLimitError } from '@/lib/integrations/types'
import type {
  KrogerTokenResponse,
  KrogerProductSearchResponse,
  KrogerProduct,
  KrogerLocation,
  KrogerCartItem,
} from './types'

import { reportError } from '@/lib/observability/report-error'
import { KROGER_TIMEOUT_MS, isTimeoutError } from '@/lib/http/timeout'

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
// Fails CLOSED if the limiter check itself errors (checkLimit's
// onError: 'deny'). These are Kroger's own published DAILY quotas, i.e. an
// external spend/quota ceiling rather than an inbound abuse throttle — and a
// ceiling that disappears during a Redis outage is not a ceiling. Burning
// through Kroger's 10,000/day Products budget while Redis is down would take
// cart automation out for every tenant until the next daily reset, which is a
// far worse outcome than deferring cart builds for the length of the outage.
// Same fail-CLOSED stance as claimNudgeBudgetSlot's SMS spend ceiling
// (CLAUDE.md), and the opposite of the abuse limiters in lib/rate-limit.ts /
// proxy.ts, which deliberately fail open.
//
// checkLimit() also short-circuits entirely when Upstash is unconfigured, so
// CI and preview deploys no longer pay @upstash/redis's ~4.3s internal retry
// on every outbound Kroger call.
async function krogerFetch(
  limiter:    Ratelimit,
  identifier: string,
  input:      string,
  init:       RequestInit,
): Promise<Response> {
  const decision = await checkLimit(limiter, identifier, {
    onError: 'deny',
    site:    `lib.kroger.client.krogerFetch.${identifier}`,
  })
  if (!decision.allowed) {
    // On an errored decision there is no real window to wait for (reset is
    // Date.now()), and retryAfterSeconds would floor to 1s — back off a full
    // minute instead so a Redis outage isn't hammered by immediate retries.
    throw new RateLimitError(decision.errored ? 60 : retryAfterSeconds(decision))
  }

  // Every Kroger call funnels through here, so the timeout budget is applied
  // once, at the chokepoint — same reasoning as the rate limiter above.
  // A caller-supplied signal wins (nothing sets one today).
  let res: Response
  try {
    res = await fetch(input, { signal: AbortSignal.timeout(KROGER_TIMEOUT_MS), ...init })
  } catch (err) {
    if (isTimeoutError(err)) {
      // Distinct from a Kroger-returned failure: rethrown (so the Inngest
      // step retries) but named so a slow-API incident is legible in logs
      // instead of looking like a generic network blip.
      console.error('[Kroger] request timed out', { timeoutMs: KROGER_TIMEOUT_MS })
      reportError(err, { site: 'lib.kroger.client.krogerFetch', extra: { timedOut: true } })
      throw new Error(`Kroger request timed out after ${KROGER_TIMEOUT_MS}ms`)
    }
    throw err
  }

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
