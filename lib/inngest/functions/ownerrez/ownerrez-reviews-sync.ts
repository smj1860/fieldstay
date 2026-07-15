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
    // Isolates a per-connection failure (not rate-limit, not revocation) so
    // it can't abort the whole run — logs it and records it on this
    // connection's own metadata for visibility. The next 6-hour cron tick
    // retries this connection; other connections in this same tick are
    // unaffected, matching how incremental-sync.ts isolates failures.
    async function recordReviewsSyncError(
      userId: string,
      meta:   Record<string, unknown>,
      err:    unknown,
    ): Promise<void> {
      const humanError = translateSyncError(err)
      logger.error(`[OwnerRez:${userId}] Reviews fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      await step.run(`record-reviews-sync-error-${userId}`, async () => {
        const admin = createServiceClient()
        await admin
          .from('integration_connections')
          .update({
            metadata: {
              ...meta,
              last_reviews_sync_status: 'error',
              last_reviews_sync_error:  humanError,
            },
          })
          .eq('user_id', userId)
          .eq('provider_id', 'ownerrez')
      })
    }

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

      // Set when the rate-limit retry below itself fails, so the shared
      // generic-error handling further down (which both this and the
      // outer catch route into) applies to it too instead of the retry's
      // own failure propagating uncaught out of this connection's turn.
      let retryFailed: unknown = null

      try {
        reviews = await step.run(`fetch-reviews-${userId}`, async () => {
          return new OwnerRezApiClient(userId).getReviews({ sinceUtc: cursor })
        })
      } catch (err) {
        if (err instanceof RateLimitError) {
          await step.sleep(`rate-limit-sleep-${userId}`, `${err.retryAfter}s`)
          try {
            reviews = await step.run(`fetch-reviews-retry-${userId}`, async () => {
              return new OwnerRezApiClient(userId).getReviews({ sinceUtc: cursor })
            })
          } catch (retryErr) {
            retryFailed = retryErr
          }
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
          // Not a rate-limit or revocation — isolate this connection's
          // failure rather than re-throwing. Re-throwing here previously
          // aborted the whole function on Inngest's retry mechanism, which
          // meant one tenant's transient error (network blip, 500) could
          // block every other tenant's review sync for this tick — later
          // connections in this loop never got processed if the retries
          // were exhausted.
          await recordReviewsSyncError(userId, meta, err)
          continue
        }
      }

      if (retryFailed) {
        // The rate-limit retry itself failed — same isolation treatment,
        // otherwise this would propagate uncaught out of this connection's
        // turn and abort the whole run.
        await recordReviewsSyncError(userId, meta, retryFailed)
        continue
      }

      try {
        await step.run(`upsert-reviews-${userId}`, async () => {
          const admin = createServiceClient()
          if (reviews.length === 0) return

          const propertyExternalIds = reviews
            .map(r => r.property_id)
            .filter((id): id is number => id !== null)
            .map(String)

          const propertyMap: Map<string, string> = new Map()
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

          // ✅ Confirmed live 2026-07-15 — see OwnerRezReview's doc comment.
          // stars (not rating), display_name (not guest_name/guest.name),
          // and date/created_utc (not created_at/submitted_at) are the real
          // fields.
          const rows = reviews.map(review => ({
            external_id:     String(review.id),
            external_source: 'ownerrez',
            external_url:    `https://app.ownerrez.com/reviews/${review.id}`,
            org_id:          orgId,
            property_id:     review.property_id
              ? (propertyMap.get(String(review.property_id)) ?? null)
              : null,
            guest_name:  review.display_name ?? null,
            rating:      review.stars,
            review_text: review.body ?? '',
            review_date: review.date ?? review.created_utc ?? null,
          }))

          const { error: upsertErr } = await admin
            .from('reviews')
            .upsert(rows, {
              onConflict: 'org_id,external_id,external_source',
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
      } catch (err) {
        // Same isolation as the fetch failures above — an upsert or
        // cursor-update failure for this connection shouldn't stop the
        // rest of the loop from running.
        await recordReviewsSyncError(userId, meta, err)
      }
    }
  }
)
