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

import { createServiceClient }  from '@/lib/supabase/server'
import { readIntegrationToken }  from '../vault'
import { TokenRevokedError, RateLimitError } from '../types'
import type {
  OwnerRezProperty,
  OwnerRezBooking,
  OwnerRezGuest,
  OwnerRezUser,
  OwnerRezPagedResponse,
} from '../types'

const BASE_URL   = 'https://api.ownerrez.com'
const PROVIDER   = 'ownerrez'

export class OwnerRezApiClient {
  constructor(private readonly userId: string) {}

  // ── Core fetch with auth + error handling ──────────────────────────────────

  private async fetch<T>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
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
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent':    `FieldStay/1.0 (${clientId})`,
        'Accept':        'application/json',
      },
    })

    if (res.status === 401) {
      // Token has been revoked — mark connection as error
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

    return res.json() as Promise<T>
  }

  private async markConnectionError(): Promise<void> {
    const supabase = createServiceClient()
    await supabase
      .from('integration_connections')
      .update({ status: 'error' })
      .eq('user_id', this.userId)
      .eq('provider_id', PROVIDER)
  }

  // ── Pagination helper ──────────────────────────────────────────────────────

  private async fetchAllPages<T>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T[]> {
    const results: T[] = []
    let nextPageToken: string | null | undefined = undefined

    do {
      const pageParams = { ...params } as Record<string, string | number | undefined>
      if (nextPageToken) pageParams['page_token'] = nextPageToken

      const page = await this.fetch<OwnerRezPagedResponse<T>>(path, pageParams)

      results.push(...page.items)
      nextPageToken = page.next_page_token
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
      queryParams['property_id'] = params.propertyIds.join(',')
    }
    if (params.includeGuest) queryParams['include_guest'] = 'true'
    return this.fetchAllPages<OwnerRezBooking>('/v2/bookings', queryParams)
  }

  async getGuests(params: { sinceUtc?: string } = {}): Promise<OwnerRezGuest[]> {
    const queryParams: Record<string, string | number | undefined> = {}
    if (params.sinceUtc) queryParams['since_utc'] = params.sinceUtc
    return this.fetchAllPages<OwnerRezGuest>('/v2/guests', queryParams)
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
