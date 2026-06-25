/**
 * OwnerRez API client — typed, reusable, handles auth + pagination.
 *
 * Every request:
 *  - Fetches the access token for the given userId from Vault
 *  - Sets Authorization: Bearer <token>
 *  - Sets User-Agent: FieldStay/1.0 (OWNERREZ_CLIENT_ID)
 *  - Handles 401 → TokenRevokedError (marks connection as error)
 *  - Handles 429 → RateLimitError with Retry-After
 *  - Paginates automatically — all list methods return a complete array
 */

import { Redis }               from '@upstash/redis'
import { createServiceClient }  from '@/lib/supabase/server'
import { readIntegrationToken }  from '../vault'
import { TokenRevokedError, RateLimitError } from '../types'
import type {
  OwnerRezProperty,
  OwnerRezBooking,
  OwnerRezGuest,
  OwnerRezUser,
  OwnerRezReview,
  OwnerRezPagedResponse,
} from '../types'

const BASE_URL   = 'https://api.ownerrez.com'
const PROVIDER   = 'ownerrez'

interface OwnerRezWebhookSubscription {
  id?:        number
  url:        string
  event_type: string
  is_active?: boolean
}

// ── Shared IP rate-limit budget tracker ──────────────────────────────────────
//
// OwnerRez limits 300 requests per 5-minute rolling window per IP address —
// not per OAuth token. All FieldStay tenants share a single Vercel deployment
// IP. A single large tenant triggering an initial sync can exhaust the pool
// mid-loop, causing 429s for every other tenant in the same cron tick.
//
// This Upstash counter proactively throws RateLimitError at 270/300 (10%
// headroom) before OwnerRez issues a real 429, keeping us below the hard limit.

const RATE_LIMIT_KEY    = 'ownerrez:ip:request_count'
const RATE_LIMIT_WINDOW = 5 * 60   // 5 minutes in seconds
const RATE_LIMIT_BUDGET = 270      // 270/300 — 10% headroom before auto-disable

let _redis: Redis | null = null
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url:   process.env.upstash_fieldstay_KV_REST_API_URL!,
      token: process.env.upstash_fieldstay_KV_REST_API_TOKEN!,
    })
  }
  return _redis
}

async function checkAndIncrementRequestBudget(): Promise<void> {
  const redis    = getRedis()
  const pipeline = redis.pipeline()
  pipeline.incr(RATE_LIMIT_KEY)
  pipeline.ttl(RATE_LIMIT_KEY)
  const [count, ttl] = await pipeline.exec() as [number, number]

  // Set window expiry only on the first request (ttl = -1 means no expiry set yet)
  if (ttl === -1) {
    await redis.expire(RATE_LIMIT_KEY, RATE_LIMIT_WINDOW)
  }

  if (count > RATE_LIMIT_BUDGET) {
    // Proactive throw — tell callers how long to wait for the window to expire
    const remainingSeconds = ttl > 0 ? ttl : RATE_LIMIT_WINDOW
    throw new RateLimitError(remainingSeconds)
  }
}

export class OwnerRezApiClient {
  constructor(private readonly userId: string) {}

  // ── Core fetch with auth + error handling ──────────────────────────────────

  private async fetch<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
    options?: { method?: string; body?: string }
  ): Promise<T> {
    // HIGH-2: check shared IP budget before making the request.
    // Throws RateLimitError proactively at 270/300 to prevent exhausting the pool
    // shared by all tenants on the same Vercel deployment IP.
    await checkAndIncrementRequestBudget()

    const clientId = process.env.OWNERREZ_CLIENT_ID
    if (!clientId) throw new Error('OWNERREZ_CLIENT_ID is not set')

    const token = await readIntegrationToken(this.userId, PROVIDER)
    if (!token) {
      throw new TokenRevokedError(this.userId)
    }

    const url = new URL(`${BASE_URL}${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }

    const res = await globalThis.fetch(url.toString(), {
      method:  options?.method ?? 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent':    `FieldStay/1.0 (${clientId})`,
        'Accept':        'application/json',
        ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(30_000),
      ...(options?.body ? { body: options.body } : {}),
    })

    if (res.status === 401) {
      // Token has been revoked (or rejected) — capture OwnerRez's reason before
      // marking the connection as error, since the token itself is never logged
      const body = await res.text().catch(() => '')
      console.error(`[OwnerRez:${this.userId}] 401 on ${path}: ${body}`)
      await this.markConnectionError()
      throw new TokenRevokedError(this.userId)
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10)
      throw new RateLimitError(retryAfter)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`[OwnerRez:${this.userId}] ${path} → ${res.status}: ${body}`)
    }

    const body = await res.json() as Record<string, unknown>

    // OwnerRez uses semantic HTTP codes primarily, but can return
    // { success: false } or { error: '...' } on a 200 for certain
    // validation failures. Catch these before returning to the caller.
    if (body?.success === false || body?.error) {
      throw new Error(
        `[OwnerRez:${this.userId}] ${path} → 200 with error body: ` +
        String(body?.error ?? body?.message ?? JSON.stringify(body))
      )
    }

    return body as T
  }

  private async markConnectionError(): Promise<void> {
    const supabase = createServiceClient()

    const { data: conn } = await supabase
      .from('integration_connections')
      .select('org_id')
      .eq('user_id', this.userId)
      .eq('provider_id', PROVIDER)
      .single()

    await supabase
      .from('integration_connections')
      .update({ status: 'error' })
      .eq('user_id', this.userId)
      .eq('provider_id', PROVIDER)

    try {
      const { inngest } = await import('@/lib/inngest/client')
      await inngest.send({
        name: 'integration/connection.error',
        data: {
          user_id:     this.userId,
          org_id:      conn?.org_id ?? '',
          provider_id: PROVIDER,
          reason:      'Token revoked or expired — 401 received from OwnerRez API',
        },
      })
    } catch {
      // Non-fatal — token is already marked error
    }
  }

  // ── Pagination helper ──────────────────────────────────────────────────────

  private async fetchAllPages<T>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T[]> {
    const results: T[] = []
    let nextPageToken: string | null | undefined = undefined
    let pageCount = 0
    const MAX_PAGES = 200  // 200 × 100 items = 20,000 results — generous ceiling

    do {
      pageCount++
      if (pageCount > MAX_PAGES) {
        console.error(`[OwnerRez] fetchAllPages: exceeded ${MAX_PAGES} pages — aborting to prevent infinite loop`)
        break
      }

      const pageParams = { ...params } as Record<string, string | number | undefined>
      if (nextPageToken) pageParams['page_token'] = nextPageToken

      const page = await this.fetch<OwnerRezPagedResponse<T>>(path, pageParams)
      const items = Array.isArray(page?.items) ? page.items : []
      results.push(...items)
      nextPageToken = page?.next_page_token ?? null
    } while (nextPageToken)

    return results
  }

  // ── Public methods ─────────────────────────────────────────────────────────

  async getProperties(): Promise<OwnerRezProperty[]> {
    return this.fetchAllPages<OwnerRezProperty>('/v2/properties')
  }

  async getBookings(params: {
    propertyIds?:  number[]
    sinceUtc?:     string
    includeGuest?: boolean
  }): Promise<OwnerRezBooking[]> {
    const queryParams: Record<string, string | number | undefined> = {}
    if (params.sinceUtc) queryParams['since_utc'] = params.sinceUtc
    if (params.propertyIds?.length) {
      queryParams['property_ids'] = params.propertyIds.join(',')
    }
    if (params.includeGuest) queryParams['include_guest'] = 'true'
    return this.fetchAllPages<OwnerRezBooking>('/v2/bookings', queryParams)
  }

  async getGuests(params: { sinceUtc?: string } = {}): Promise<OwnerRezGuest[]> {
    const queryParams: Record<string, string | number | undefined> = {}
    if (params.sinceUtc) queryParams['since_utc'] = params.sinceUtc
    return this.fetchAllPages<OwnerRezGuest>('/v2/guests', queryParams)
  }

  async getReviews(params: { sinceUtc?: string } = {}): Promise<OwnerRezReview[]> {
    const queryParams: Record<string, string | number | undefined> = {}
    if (params.sinceUtc) queryParams['since_utc'] = params.sinceUtc
    return this.fetchAllPages<OwnerRezReview>('/v2/reviews', queryParams)
  }

  async registerWebhookSubscriptions(webhookBaseUrl: string): Promise<void> {
    const eventsToRegister = [
      'booking.created',
      'booking.modified',
      'booking.cancelled',
      'guest.created',
      'guest.updated',
    ]

    const existing = await this.fetchAllPages<OwnerRezWebhookSubscription>(
      '/v2/webhooksubscriptions'
    )
    const existingUrls = new Set(
      existing
        .filter(s => s.url === webhookBaseUrl && s.is_active)
        .map(s => s.event_type)
    )

    for (const eventType of eventsToRegister) {
      if (existingUrls.has(eventType)) continue

      await this.fetch('/v2/webhooksubscriptions', undefined, {
        method: 'POST',
        body: JSON.stringify({ url: webhookBaseUrl, event_type: eventType, is_active: true }),
      })
    }
  }

  async getCurrentUser(): Promise<OwnerRezUser> {
    return this.fetch<OwnerRezUser>('/v2/users/me')
  }

  async deleteAccessToken(token: string): Promise<void> {
    const clientId     = process.env.OWNERREZ_CLIENT_ID
    const clientSecret = process.env.OWNERREZ_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new Error('OWNERREZ_CLIENT_ID or OWNERREZ_CLIENT_SECRET is not set')
    }
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    await globalThis.fetch(`${BASE_URL}/oauth/access_token/${token}`, {
      method:  'DELETE',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'User-Agent':    `FieldStay/1.0 (${clientId})`,
      },
    })
  }
}
