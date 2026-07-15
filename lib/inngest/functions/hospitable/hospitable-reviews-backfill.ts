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

      const token = await step.run('read-token', async () => getValidHospitableToken(user_id))

      // Reviews are fetched per-property (GET /properties/{uuid}/reviews —
      // there is no flat account-wide collection, see hospFetchReviews' doc
      // comment), so each property gets its own fetch step. The FieldStay
      // property_id is already known here — no need to resolve it back out
      // of the response's property.id the way the review.created webhook
      // handler has to (that path doesn't know which property triggered it
      // up front).
      const reviewRows: Array<{
        org_id:          string
        external_id:     string
        external_source: string
        external_url:    null
        property_id:     string
        guest_name:      string | null
        rating:          number
        review_text:     string
        review_date:     string | null
        response_status: string
      }> = []

      for (const property of properties) {
        const propertyId         = property.id as string
        const propertyExternalId = property.external_id as string

        let propertyReviews
        try {
          propertyReviews = await step.run(`fetch-reviews-${propertyId}`, async () =>
            hospFetchReviews(token, propertyExternalId)
          )
        } catch (err) {
          if (!(err instanceof RateLimitError)) throw err
          await step.sleep(`rate-limit-sleep-${propertyId}`, `${err.retryAfter}s`)
          propertyReviews = await step.run(`fetch-reviews-retry-${propertyId}`, async () =>
            hospFetchReviews(token, propertyExternalId)
          )
        }

        for (const review of propertyReviews) {
          const guestName = [review.guest?.first_name, review.guest?.last_name]
            .filter(Boolean)
            .join(' ') || null

          reviewRows.push({
            org_id,
            external_id:     review.id,
            external_source: PROVIDER,
            external_url:    null,
            property_id:     propertyId,
            guest_name:      guestName,
            rating:          review.public.rating,
            review_text:     review.public.review,
            review_date:     review.reviewed_at,
            response_status: 'pending',
          })
        }
      }

      logger.info(`[Hospitable:${user_id}] Fetched ${reviewRows.length} historical reviews`)

      const reviewCount = await step.run('upsert-reviews', async () => {
        if (reviewRows.length === 0) return 0

        const supabase = createServiceClient()
        const { error } = await supabase
          .from('reviews')
          .upsert(reviewRows, {
            onConflict:       'org_id,external_id,external_source',
            ignoreDuplicates: false,
          })

        if (error) {
          throw new Error(`[Hospitable:${user_id}] Reviews upsert failed: ${error.message}`)
        }

        return reviewRows.length
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
