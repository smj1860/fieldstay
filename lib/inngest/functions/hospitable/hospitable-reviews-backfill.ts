// lib/inngest/functions/hospitable/hospitable-reviews-backfill.ts
// ============================================================
// Triggered by: integration/hospitable.connected
//
// One-time historical review backfill. Hospitable's review.created /
// review.changed webhooks (see incremental-sync.ts) already cover every
// review created or changed AFTER a PM connects — but a webhook only fires
// for events that happen after the subscription exists, so a review posted
// before the PM ever connected Hospitable never syncs any other way. This
// function closes that one gap, once per connection.
//
// Deliberately has NO recurring cron, unlike ownerrez-reviews-sync.ts:
// OwnerRez has no review webhook at all, so its 6-hourly cron is the ONLY
// way ongoing reviews ever sync. Hospitable already has push coverage for
// everything going forward via the webhook path, and GET /reviews has no
// documented incremental "since" filter (see hospFetchReviews' doc comment)
// — a repeating full re-fetch here would just re-download the same history
// on every tick for no benefit.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { RateLimitError, translateSyncError } from '@/lib/integrations/types'
import { hospFetchReviews } from '@/lib/integrations/providers/hospitable'

const PROVIDER = 'hospitable'

export const hospReviewsBackfill = inngest.createFunction(
  {
    id:          'hospitable-reviews-backfill',
    name:        'Hospitable — Reviews Backfill',
    retries:     2,
    concurrency: { limit: 1, key: 'event.data.org_id' },
  },
  { event: 'integration/hospitable.connected' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    try {
      const properties = await step.run('fetch-org-properties', async () => {
        const supabase = createServiceClient()
        const { data } = await supabase
          .from('properties')
          .select('id, external_id')
          .eq('org_id', org_id)
          .eq('external_source', PROVIDER)
          .not('external_id', 'is', null)
        return data ?? []
      })

      if (properties.length === 0) {
        logger.info(`[Hospitable:${user_id}] Reviews backfill skipped — no synced properties yet`)
        return { reviews: 0 }
      }

      const propertyMap = new Map(
        properties.map((p) => [p.external_id as string, p.id as string])
      )
      const propertyExternalIds = Array.from(propertyMap.keys())

      const token = await step.run('read-token', async () => getValidHospitableToken(user_id))

      let reviews
      try {
        reviews = await step.run('fetch-reviews', async () => {
          return hospFetchReviews(token, propertyExternalIds)
        })
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err
        await step.sleep('rate-limit-sleep', `${err.retryAfter}s`)
        reviews = await step.run('fetch-reviews-retry', async () => {
          return hospFetchReviews(token, propertyExternalIds)
        })
      }

      logger.info(`[Hospitable:${user_id}] Fetched ${reviews.length} historical reviews`)

      const reviewCount = await step.run('upsert-reviews', async () => {
        if (reviews.length === 0) return 0

        const rows = reviews.map((review) => {
          const guestName = [review.guest?.first_name, review.guest?.last_name]
            .filter(Boolean)
            .join(' ') || null

          const hospPropertyId = review.property?.id ?? null

          return {
            org_id,
            external_id:     review.id,
            external_source: PROVIDER,
            external_url:    null,
            property_id:     hospPropertyId ? (propertyMap.get(hospPropertyId) ?? null) : null,
            guest_name:      guestName,
            rating:          review.public?.rating ?? 0,
            review_text:     review.public?.review ?? '',
            review_date:     review.reviewed_at ?? null,
            response_status: 'pending',
          }
        })

        const supabase = createServiceClient()
        const { error } = await supabase
          .from('reviews')
          .upsert(rows, {
            onConflict:       'org_id,external_id,external_source',
            ignoreDuplicates: false,
          })

        if (error) {
          throw new Error(`[Hospitable:${user_id}] Reviews upsert failed: ${error.message}`)
        }

        return rows.length
      })

      await step.run('record-backfill-success', async () => {
        await updateConnectionMeta(user_id, {
          last_reviews_backfill_status: 'success',
          last_reviews_backfill_error:  null,
          last_reviews_backfill_at:     new Date().toISOString(),
          last_reviews_backfill_count:  reviewCount,
        })
      })

      logger.info(`[Hospitable:${user_id}] Reviews backfill complete — ${reviewCount} reviews`)

      return { reviews: reviewCount }
    } catch (err) {
      const friendlyMsg = translateSyncError(err, 'Hospitable')
      logger.error(`[Hospitable:${user_id}] Reviews backfill failed: ${err instanceof Error ? err.message : String(err)}`)

      await step.run('record-backfill-error', async () => {
        await updateConnectionMeta(user_id, {
          last_reviews_backfill_status: 'error',
          last_reviews_backfill_error:  friendlyMsg,
          last_reviews_backfill_at:     new Date().toISOString(),
        })
      })

      throw err
    }
  }
)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateConnectionMeta(
  userId: string,
  patch:  Record<string, unknown>
): Promise<void> {
  const supabase = createServiceClient()
  const { data: existing } = await supabase
    .from('integration_connections')
    .select('metadata')
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {}

  await supabase
    .from('integration_connections')
    .update({ metadata: { ...existingMeta, ...patch } })
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
}
