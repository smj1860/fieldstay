import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { RateLimitError } from '@/lib/integrations/types'

interface OwnerRezReview {
  id: number
  rating: number
  comments?: string
  body?: string
  review_text?: string
  guest_name?: string
  guest?: { name?: string }
  created_at?: string
  submitted_at?: string
  property_id?: number
}

interface OwnerRezReviewsPage {
  items: OwnerRezReview[]
  next_page_token?: string
}

async function fetchAllReviews(
  userId: string,
  sinceUtc?: string
): Promise<OwnerRezReview[]> {
  const token = await readIntegrationToken(userId, 'ownerrez')
  if (!token) throw new Error(`[OwnerRez:${userId}] No token found`)

  const clientId = process.env.OWNERREZ_CLIENT_ID
  if (!clientId) throw new Error('Missing OWNERREZ_CLIENT_ID env var')

  const headers: HeadersInit = {
    Authorization: `Bearer ${token}`,
    'User-Agent':  `FieldStay/1.0 (${clientId})`,
    Accept:        'application/json',
  }

  const allReviews: OwnerRezReview[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams()
    if (sinceUtc) params.set('since_utc', sinceUtc)
    if (pageToken) params.set('page_token', pageToken)

    const url = `https://api.ownerrez.com/v2/reviews?${params.toString()}`
    const res  = await fetch(url, { headers })

    if (res.status === 401) {
      // Mark connection as error
      const admin = createServiceClient()
      await admin
        .from('integration_connections')
        .update({ status: 'error' })
        .eq('user_id', userId)
        .eq('provider_id', 'ownerrez')
      throw new Error(`[OwnerRez:${userId}] Token revoked (401)`)
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '60')
      throw new RateLimitError(retryAfter)
    }

    if (!res.ok) {
      throw new Error(`[OwnerRez:${userId}] GET /v2/reviews returned ${res.status}`)
    }

    const page = (await res.json()) as OwnerRezReviewsPage
    allReviews.push(...(page.items ?? []))
    pageToken = page.next_page_token
  } while (pageToken)

  return allReviews
}

export const ownerRezReviewsSync = inngest.createFunction(
  {
    id:   'ownerrez-reviews-sync',
    name: 'OwnerRez — Reviews Sync',
  },
  [
    { cron: '0 */6 * * *' },
    { event: 'integration/ownerrez.connected' },
  ],
  async ({ step }) => {
    const admin = createServiceClient()

    const { data: connections, error } = await admin
      .from('integration_connections')
      .select('user_id, org_id, metadata')
      .eq('provider_id', 'ownerrez')
      .eq('status', 'active')

    if (error) {
      throw new Error(`[OwnerRez reviews sync] Failed to fetch connections: ${error.message}`)
    }

    for (const conn of connections ?? []) {
      const userId = conn.user_id as string
      const orgId  = conn.org_id  as string
      const meta   = (conn.metadata as Record<string, unknown> | null) ?? {}
      const cursor = typeof meta['reviews_sync_cursor'] === 'string'
        ? meta['reviews_sync_cursor']
        : undefined

      let reviews: OwnerRezReview[] = []

      try {
        reviews = await step.run(`fetch-reviews-${userId}`, async () => {
          return fetchAllReviews(userId, cursor)
        })
      } catch (err) {
        if (err instanceof RateLimitError) {
          // err.retryAfter is in SECONDS; pass a duration string — not milliseconds.
          // The previous `retryAfter * 1000` would sleep ~16 hours instead of ~60 sec.
          await step.sleep(`rate-limit-sleep-${userId}`, `${err.retryAfter}s`)
          reviews = await step.run(`fetch-reviews-retry-${userId}`, async () => {
            return fetchAllReviews(userId, cursor)
          })
        } else {
          console.error(`[OwnerRez:${userId}] Reviews fetch failed:`, err)
          continue
        }
      }

      await step.run(`upsert-reviews-${userId}`, async () => {
        if (reviews.length === 0) return

        // Fetch properties for property_id lookup
        const propertyExternalIds = reviews
          .map(r => r.property_id)
          .filter((id): id is number => id != null)
          .map(String)

        let propertyMap: Map<string, string> = new Map()
        if (propertyExternalIds.length > 0) {
          const { data: props } = await admin
            .from('properties')
            .select('id, external_id')
            .eq('org_id', orgId)
            .in('external_id', propertyExternalIds)

          for (const p of props ?? []) {
            if (p.external_id) propertyMap.set(p.external_id, p.id as string)
          }
        }

        const rows = reviews.map(review => ({
          external_id:     String(review.id),
          external_source: 'ownerrez',
          external_url:    `https://app.ownerrez.com/reviews/${review.id}`,
          org_id:          orgId,
          property_id:     review.property_id
            ? (propertyMap.get(String(review.property_id)) ?? null)
            : null,
          guest_name:  review.guest_name ?? review.guest?.name ?? null,
          rating:      review.rating,
          review_text: review.comments ?? review.body ?? review.review_text ?? '',
          review_date: review.created_at ?? review.submitted_at ?? null,
        }))

        const { error: upsertErr } = await admin
          .from('reviews')
          .upsert(rows, {
            onConflict: 'external_id,external_source',
            ignoreDuplicates: false,
          })

        if (upsertErr) {
          throw new Error(`[OwnerRez:${userId}] Reviews upsert failed: ${upsertErr.message}`)
        }
      })

      await step.run(`update-reviews-cursor-${userId}`, async () => {
        const newCursor = new Date().toISOString()
        const newMeta   = { ...meta, reviews_sync_cursor: newCursor }

        const { error: updateErr } = await admin
          .from('integration_connections')
          .update({ metadata: newMeta })
          .eq('user_id', userId)
          .eq('provider_id', 'ownerrez')

        if (updateErr) {
          throw new Error(
            `[OwnerRez:${userId}] Failed to update reviews cursor: ${updateErr.message}`
          )
        }
      })
    }
  }
)
