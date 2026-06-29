import { inngest }            from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient }   from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import type { OwnerRezReview } from '@/lib/integrations/types'
import { logAuditEvent }       from '@/lib/audit'

export const ownerRezReviewsSync = inngest.createFunction(
  {
    id:      'ownerrez-reviews-sync',
    name:    'OwnerRez — Reviews Sync',
    retries: 2,
  },
  [
    { cron: '0 */6 * * *' },
    { event: 'integration/ownerrez.connected' },
  ],
  async ({ step, logger }) => {
    const connections = await step.run('fetch-connections', async () => {
      const admin = createServiceClient()
      const { data, error } = await admin
        .from('integration_connections')
        .select('user_id, org_id, metadata')
        .eq('provider_id', 'ownerrez')
        .eq('status', 'active')
      if (error) throw new Error(`[OwnerRez reviews sync] Failed to fetch connections: ${error.message}`)
      return data ?? []
    })

    for (const conn of connections) {
      const userId = conn.user_id as string
      const orgId  = conn.org_id  as string
      const meta   = (conn.metadata as Record<string, unknown> | null) ?? {}
      const cursor = typeof meta['reviews_sync_cursor'] === 'string'
        ? meta['reviews_sync_cursor']
        : undefined

      let reviews: OwnerRezReview[] = []

      // Capture the timestamp BEFORE the fetch so reviews submitted during the
      // fetch (with a created_at between this and the end of the fetch) are
      // re-fetched on the next sync rather than skipped.
      const fetchStartedAt = new Date().toISOString()

      try {
        reviews = await step.run(`fetch-reviews-${userId}`, async () => {
          return new OwnerRezApiClient(userId).getReviews({ sinceUtc: cursor })
        })
      } catch (err) {
        if (err instanceof RateLimitError) {
          await step.sleep(`rate-limit-sleep-${userId}`, `${err.retryAfter}s`)
          reviews = await step.run(`fetch-reviews-retry-${userId}`, async () => {
            return new OwnerRezApiClient(userId).getReviews({ sinceUtc: cursor })
          })
        } else if (err instanceof TokenRevokedError) {
          const humanError = translateSyncError(err)
          await step.run(`mark-revoked-${userId}`, async () => {
            const admin = createServiceClient()
            const { data: existing } = await admin
              .from('integration_connections')
              .select('id, metadata')
              .eq('user_id', userId)
              .eq('provider_id', 'ownerrez')
              .maybeSingle()
            const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {}

            await admin
              .from('integration_connections')
              .update({
                status:   'revoked',
                metadata: {
                  ...existingMeta,
                  last_sync_status: 'error',
                  last_sync_error:  humanError,
                  last_synced_at:   new Date().toISOString(),
                },
              })
              .eq('user_id', userId)
              .eq('provider_id', 'ownerrez')

            await logAuditEvent({
              orgId:      orgId,
              actorId:    userId,
              action:     'integration.sync_failed',
              targetType: 'integration_connection',
              targetId:   'ownerrez',
              metadata:   { provider_id: 'ownerrez', reason: 'token_revoked' },
            })

            // Fire PM notification — throttled to once per 4 hours per connection
            if (existing?.id) {
              const milestoneKey = `integration_error_notified:${existing.id}`
              const { data: recentNotification } = await admin
                .from('org_milestones')
                .select('value, achieved_at')
                .eq('org_id', orgId)
                .eq('milestone', milestoneKey)
                .order('achieved_at', { ascending: false })
                .limit(1)
                .maybeSingle()

              const lastNotifiedAt = (recentNotification?.value as Record<string, unknown> | null)
                ?.notified_at
              const tooSoon = lastNotifiedAt &&
                Date.now() - new Date(lastNotifiedAt as string).getTime() < 4 * 60 * 60 * 1000

              if (!tooSoon) {
                await step.sendEvent(`notify-revoked-${userId}`, {
                  name: 'integration/connection.error',
                  data: {
                    user_id:     userId,
                    org_id:      orgId,
                    provider_id: 'ownerrez',
                    reason:      humanError,
                  },
                })
                await admin.from('org_milestones').upsert({
                  org_id:    orgId,
                  milestone: milestoneKey,
                  value:     { notified_at: new Date().toISOString() },
                }, { onConflict: 'org_id,milestone' })
              }
            }
          })
          continue
        } else {
          // Not a rate-limit or revocation — re-throw so Inngest's retry
          // mechanism fires instead of silently skipping this connection.
          logger.error(`[OwnerRez:${userId}] Reviews fetch failed: ${err instanceof Error ? err.message : String(err)}`)
          throw err
        }
      }

      await step.run(`upsert-reviews-${userId}`, async () => {
        const admin = createServiceClient()
        if (reviews.length === 0) return

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
        const admin = createServiceClient()
        const newMeta = { ...meta, reviews_sync_cursor: fetchStartedAt }

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
