import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }      from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient }   from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import type { OwnerRezReview } from '@/lib/integrations/types'
import { logAuditEvent }       from '@/lib/audit'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { asJsonObject } from '@/lib/json'
import type { Json } from '@/types/database'

/**
 * DISPATCHER ONLY.
 *
 * This used to run `for (const conn of connections) { ... }` over every
 * OwnerRez connection on the platform inside one invocation — 3 to 6 steps
 * each, so the run's step count scaled with the whole platform.
 *
 * Two things were worse than the step count:
 *
 *  - The rate-limit backoff was a `step.sleep` INSIDE that loop. One throttled
 *    tenant put the entire run to sleep, stalling every connection queued
 *    behind it. Each connection now sleeps in its own run.
 *  - The `integration/ownerrez.connected` trigger ignored its own event
 *    payload and re-synced EVERY connection on the platform. One org
 *    connecting OwnerRez kicked off a platform-wide review sync. It now
 *    dispatches exactly the connection that fired it.
 */
export const ownerRezReviewsSync = inngest.createFunction(
  {
    id:      'ownerrez-reviews-sync',
    name:    'OwnerRez — Reviews Sync Dispatcher',
    retries: 2,
  },
  [
    { cron: '0 */6 * * *' },
    { event: 'integration/ownerrez.connected' },
  ],
  async ({ event, step, logger }) => {
    // A connect event names its own connection; the cron scans for all of
    // them. Reading the payload is what stops one org's connect from syncing
    // the platform.
    const connected = event?.name === 'integration/ownerrez.connected' ? event.data : null

    if (connected) {
      await step.sendEvent('dispatch-connected-sync', {
        name: 'integration/ownerrez_reviews.connection_requested' as const,
        data: { user_id: connected.user_id, org_id: connected.org_id },
      })
      logger.info(`[OwnerRez] Dispatched reviews sync for the newly connected account`)
      return { dispatched: 1, trigger: 'connected' as const }
    }

    const connections = await step.run('fetch-connections', async () => {
      const admin = createServiceClient({ system: 'inngest:ownerrez-reviews-sync' })
      // PLATFORM-WIDE scan — every org with a live OwnerRez connection, not
      // one tenant's. At max_rows = 1000 PostgREST returns the first 1000 with
      // a 200 and no truncation signal, so every connection past that stops
      // pulling reviews while the cron still reports success.
      return await fetchAllRows<{ user_id: string; org_id: string | null }>(
        (from, to) => admin
          .from('integration_connections')
          .select('user_id, org_id')
          .eq('provider_id', 'ownerrez')
          .eq('status', 'active')
          .order('user_id')
          .range(from, to),
        { label: 'ownerrez-reviews-sync.connections' },
      )
    })

    const dispatchable = connections.filter((c) => c.org_id !== null)

    if (dispatchable.length) {
      await step.sendEvent(
        'fan-out-reviews-sync',
        dispatchable.map((conn) => ({
          name: 'integration/ownerrez_reviews.connection_requested' as const,
          data: { user_id: conn.user_id, org_id: conn.org_id! },
        }))
      )
    }

    logger.info(`[OwnerRez] Dispatched reviews sync for ${dispatchable.length} connection(s)`)
    return { dispatched: dispatchable.length, trigger: 'cron' as const }
  }
)

/**
 * One OwnerRez connection's review sync. One invocation = one connection.
 *
 * Keyed by user_id rather than org_id because the API client, the OAuth token,
 * the rate-limit backoff and the sync cursor are all per-connection.
 */
export const ownerRezReviewsSyncConnection = inngest.createFunction(
  {
    id:          'ownerrez-reviews-sync-connection',
    name:        'OwnerRez — Reviews Sync (one connection)',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'integration/ownerrez_reviews.connection_requested' },
  async ({ event, step, logger }) => {
    // Isolates a per-connection failure (not rate-limit, not revocation) so
    // it can't abort the whole run — logs it and records it on this
    // connection's own metadata for visibility. The next 6-hour cron tick
    // retries this connection; other connections in this same tick are
    // unaffected, matching how incremental-sync.ts isolates failures.
    async function recordReviewsSyncError(
      userId: string,
      err:    unknown,
    ): Promise<void> {
      const humanError = translateSyncError(err)
      logger.error(`[OwnerRez:${userId}] Reviews fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      await step.run(`record-reviews-sync-error-${userId}`, async () => {
        await mergeIntegrationConnectionMetadata({
          userId,
          providerId: 'ownerrez',
          patch: {
            last_reviews_sync_status: 'error',
            last_reviews_sync_error:  humanError,
          },
        })
      })
    }

    // Fires the PM notification for a revoked connection, throttled to once
    // per 4 hours per connection — split out so the mark-revoked step below
    // doesn't nest the milestone lookup, the throttle check and the upsert
    // all inside its own already-deep try/catch/if chain.
    async function notifyRevokedThrottled(
      admin:         ReturnType<typeof createServiceClient>,
      userId:        string,
      orgId:         string,
      connectionId:  string,
      humanError:    string,
    ): Promise<void> {
      const milestoneKey = `integration_error_notified:${connectionId}`
      const { data: recentNotification, error: recentNotificationErr } = await admin
        .from('org_milestones')
        .select('value, achieved_at')
        .eq('org_id', orgId)
        .eq('milestone', milestoneKey)
        .order('achieved_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (recentNotificationErr) {
        throw new Error(`[OwnerRez:${userId}] Notification-milestone lookup failed: ${recentNotificationErr.message}`)
      }

      const lastNotifiedAt = (recentNotification?.value as Record<string, unknown> | null)
        ?.notified_at
      const tooSoon = lastNotifiedAt &&
        Date.now() - new Date(lastNotifiedAt as string).getTime() < 4 * 60 * 60 * 1000
      if (tooSoon) return

      await step.sendEvent(`notify-revoked-${userId}`, {
        name: 'integration/connection.error',
        data: {
          user_id:     userId,
          org_id:      orgId,
          provider_id: 'ownerrez',
          reason:      humanError,
        },
      })
      const { error: milestoneErr } = await admin.from('org_milestones').upsert({
        org_id:    orgId,
        milestone: milestoneKey,
        value:     { notified_at: new Date().toISOString() },
      }, { onConflict: 'org_id,milestone' })

      if (milestoneErr) {
        throw new Error(`[OwnerRez:${userId}] Failed to record notification milestone: ${milestoneErr.message}`)
      }
    }

    const userId = event.data.user_id
    const orgId  = event.data.org_id

    // The cursor is read HERE, not carried on the event: it advances every
    // successful sync, and a value the dispatcher snapshotted before an
    // in-flight run finished would re-pull reviews this connection already has.
    const cursor = await step.run('load-sync-cursor', async () => {
      const admin = createServiceClient({ system: 'inngest:ownerrez-reviews-sync' })
      const res = await admin
        .from('integration_connections')
        .select('metadata')
        .eq('user_id', userId)
        .eq('provider_id', 'ownerrez')
        .maybeSingle()

      if (res.error) {
        throw new Error(`[OwnerRez:${userId}] Connection metadata lookup failed: ${res.error.message}`)
      }

      const meta = asJsonObject(res.data?.metadata as Json | undefined) ?? {}
      return typeof meta['reviews_sync_cursor'] === 'string' ? meta['reviews_sync_cursor'] : null
    }) ?? undefined

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
          const admin = createServiceClient({ system: 'inngest:ownerrez-reviews-sync' })
          const { data: existing, error: existingErr } = await admin
            .from('integration_connections')
            .select('id')
            .eq('user_id', userId)
            .eq('provider_id', 'ownerrez')
            .maybeSingle()

          if (existingErr) {
            throw new Error(`[OwnerRez:${userId}] Connection lookup failed: ${existingErr.message}`)
          }

          await mergeIntegrationConnectionMetadata({
            userId,
            providerId: 'ownerrez',
            patch: {
              last_sync_status: 'error',
              last_sync_error:  humanError,
              last_synced_at:   new Date().toISOString(),
            },
            status: 'revoked',
          })

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
            await notifyRevokedThrottled(admin, userId, orgId, existing.id, humanError)
          }
        })
        return { user_id: userId, status: 'revoked' as const }
      } else {
        // Not a rate-limit or revocation — isolate this connection's
        // failure rather than re-throwing. Re-throwing here previously
        // aborted the whole function on Inngest's retry mechanism, which
        // meant one tenant's transient error (network blip, 500) could
        // block every other tenant's review sync for this tick — later
        // connections in this loop never got processed if the retries
        // were exhausted.
        await recordReviewsSyncError(userId, err)
        return { user_id: userId, status: 'error' as const }
      }
    }

    if (retryFailed) {
      // The rate-limit retry itself failed — same isolation treatment,
      // otherwise this would propagate uncaught out of this connection's
      // turn and abort the whole run.
      await recordReviewsSyncError(userId, retryFailed)
      return { user_id: userId, status: 'error' as const }
    }

    try {
      await step.run(`upsert-reviews-${userId}`, async () => {
        const admin = createServiceClient({ system: 'inngest:ownerrez-reviews-sync' })
        if (reviews.length === 0) return

        const propertyExternalIds = reviews
          .map(r => r.property_id)
          .filter((id): id is number => id !== null)
          .map(String)

        const propertyMap: Map<string, string> = new Map()
        if (propertyExternalIds.length > 0) {
          const { data: props, error: propsErr } = await admin
            .from('properties')
            .select('id, external_id')
            .eq('org_id', orgId)
            .in('external_id', propertyExternalIds)
            .limit(propertyExternalIds.length)

          if (propsErr) {
            throw new Error(`[OwnerRez:${userId}] Property lookup failed: ${propsErr.message}`)
          }

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
        try {
          await mergeIntegrationConnectionMetadata({
            userId,
            providerId: 'ownerrez',
            patch: { reviews_sync_cursor: fetchStartedAt },
          })
        } catch (err) {
          throw new Error(
            `[OwnerRez:${userId}] Failed to update reviews cursor: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      })
    } catch (err) {
      // Kept as isolation rather than a re-throw: recordReviewsSyncError
      // writes the failure onto this connection's own metadata, which is
      // what surfaces it in the integrations UI. Re-throwing would burn the
      // retries and leave nothing on the row saying why.
      await recordReviewsSyncError(userId, err)
      return { user_id: userId, status: 'error' as const }
    }

    return { user_id: userId, status: 'ok' as const, reviews: reviews.length }
  }
)
