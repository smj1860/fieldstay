/**
 * OwnerRez Incremental Sync
 *
 * Two functions:
 *
 * 1. ownerRezIncrementalSync — DISPATCHER. Triggered by:
 *     - Inngest cron:  hourly (0 * * * *) — reliability backstop, sweeps
 *                      every active connection
 *     - Webhook event: integration/ownerrez.sync.requested — scoped to the
 *                      one connection the webhook belongs to when
 *                      ownerrez.ts's handleWebhookEvent resolved it (falls
 *                      back to a full sweep when it couldn't)
 *     - Manual event:  ownerrez/sync.now.requested — always scoped to the
 *                      PM's own connection
 *    It only finds connections and fans out one
 *    `ownerrez/connection.sync.requested` event per connection.
 *
 * 2. ownerRezConnectionSync — PER-CONNECTION HANDLER. Does the actual work
 *    for one connection under its own concurrency cap and retry policy.
 *
 * Why fan-out (see FUTURE_REMEDIATION.md's OwnerRez scaling note): the
 * previous shape looped every connection serially inside one invocation.
 * A RateLimitError from the shared-IP budget broke the WHOLE tick — every
 * connection after the one that tripped it was parked until the next
 * hourly cron. With per-connection runs, a rate-limited connection retries
 * alone with Inngest's backoff (resuming as soon as the 5-minute budget
 * window rolls) and no other tenant is affected. Fair-share enforcement
 * lives in ownerrez-api.ts's checkAndIncrementRequestBudget, which caps a
 * single connection to half the budget under contention.
 *
 * The per-connection new-property diff (a full getProperties() call) used
 * to run every tick for every connection — 100+ requests/hour of pure
 * diffing at 100 connections. New-property discovery is now webhook-primary:
 * ownerrez.ts routes property entity_insert/entity_create webhooks into the
 * scoped sync path (scoped runs always request the diff), so a property
 * added in OwnerRez is discovered within moments. The hourly cron only
 * requests the diff once a day (NEW_PROPERTY_DIFF_UTC_HOUR) as a
 * missed-webhook backstop; manual "Resync" clicks also always request it.
 *
 * TODO(CLAUDE_55_5 Task 7): This function does not currently handle OwnerRez
 * property entity_update webhooks — it only fetches bookings via since_utc.
 * Once property-level webhook handling exists here, add a getPropertyDetail()
 * call (and the guidebook-config patch from initial-sync.ts's
 * fetch-property-details/sync-guidebook-configs-from-property steps) for the
 * specific property that was updated, scoped per the patch's
 * "Do not add webhook handling that isn't already scoped" instruction.
 */

import { inngest }                      from '@/lib/inngest/client'
import { NonRetriableError }            from 'inngest'
import { createServiceClient }          from '@/lib/supabase/server'
import { OwnerRezApiClient, getRedis }  from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import { logAuditEvent }                from '@/lib/audit'
import { reportError }                  from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { createPmNotification }         from '@/lib/inngest/helpers'
import { findMaintenanceCandidatesForWindow } from '@/lib/maintenance/vacancy-suggestions'
import { createGuidebookPropertyConfigsForProperties } from '@/lib/guidebook/sync'
import { seedPresentAssetsFromAmenities } from '@/lib/asset-discovery/seed-from-amenities'
import {
  buildOwnerRezBookingRow,
  selectOwnerRezBookingsToPostRevenue,
} from '@/lib/integrations/providers/ownerrez'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'

const PROVIDER = 'ownerrez'

const CIRCUIT_KEY       = 'ownerrez:circuit:consecutive_failures'
const CIRCUIT_THRESHOLD = 10

// The cron tick (hourly, minute 0) whose fan-out requests the new-property
// diff — 10:00 UTC is early-morning US, away from the 13:00-14:00 UTC daily
// cron cluster and low booking-webhook traffic.
const NEW_PROPERTY_DIFF_UTC_HOUR = 10

export const ownerRezIncrementalSync = inngest.createFunction(
  {
    id:          'ownerrez-incremental-sync',
    name:        'OwnerRez Incremental Sync',
    retries:     2,
    concurrency: { limit: 1 },
  },
  [
    { cron: '0 * * * *' },
    { event: 'integration/ownerrez.sync.requested' as const },
    { event: 'ownerrez/sync.now.requested' as const },
  ],
  async ({ event, step, logger }) => {
    // Inngest's synthetic cron-tick event has no `data.user_id` — only the
    // two real event triggers carry one, and only when the webhook path
    // successfully resolved a connection (see ownerrez.ts's
    // handleWebhookEvent). Its absence means "do a full sweep", the same
    // behavior this function always had before scoping existed.
    const scopedUserId = event?.data && 'user_id' in event.data ? event.data.user_id : undefined
    logger.info('ownerrez-incremental-sync triggered', { scoped: Boolean(scopedUserId) })

    // Circuit breaker: if the OwnerRez API is degraded, skip this tick
    // entirely rather than queueing per-connection runs that will all fail.
    const circuitOpen = await step.run('check-circuit-breaker', async () => {
      const redis     = getRedis()
      const failCount = await redis.get<number>(CIRCUIT_KEY) ?? 0
      return failCount >= CIRCUIT_THRESHOLD
    })

    if (circuitOpen) {
      logger.warn('[OwnerRez] Circuit breaker open — skipping tick, waiting for recovery')
      return { dispatched: 0, circuit_open: true }
    }

    const connections = await step.run('fetch-connections', async () => {
      const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
      let query = supabase
        .from('integration_connections')
        .select('id, user_id, org_id, external_user_id')
        .eq('provider_id', PROVIDER)
        .eq('status', 'active')

      if (scopedUserId) query = query.eq('user_id', scopedUserId)

      const { data } = await query
      return data ?? []
    })

    if (!connections.length) {
      logger.info('[OwnerRez] No active connections to sync')
      return { dispatched: 0 }
    }

    // The new-property diff costs one full getProperties() per connection —
    // budget-relevant at scale. Discovery is webhook-primary (see header):
    // the hourly backstop only requests it once a day, for webhooks that
    // never arrived. Scoped (webhook/manual) runs always get it.
    const checkNewProperties = scopedUserId
      ? true
      : new Date().getUTCHours() === NEW_PROPERTY_DIFF_UTC_HOUR

    await step.sendEvent(
      'fan-out-connection-syncs',
      connections.map((conn) => ({
        name: 'ownerrez/connection.sync.requested' as const,
        data: {
          connection_id:        conn.id,
          user_id:              conn.user_id,
          org_id:               conn.org_id ?? '',
          external_user_id:     conn.external_user_id ?? '',
          check_new_properties: checkNewProperties,
        },
      }))
    )

    return { dispatched: connections.length }
  }
)

export const ownerRezConnectionSync = inngest.createFunction(
  {
    id:          'ownerrez-connection-sync',
    name:        'OwnerRez Connection Sync — per connection',
    retries:     3,
    // Global cap on concurrent OwnerRez API pressure. The shared-IP budget
    // in ownerrez-api.ts is the hard limit; this keeps burst shape sane.
    concurrency: { limit: 3 },
  },
  { event: 'ownerrez/connection.sync.requested' },
  async ({ event, step, logger }) => {
    const { connection_id: connectionId, user_id: userId, check_new_properties: checkNewProperties } = event.data
    const orgId = event.data.org_id || null

    // Queued runs dispatched before the breaker opened must not pile onto a
    // degraded API — re-check here, not just in the dispatcher.
    const circuitOpen = await step.run('check-circuit-breaker', async () => {
      const redis     = getRedis()
      const failCount = await redis.get<number>(CIRCUIT_KEY) ?? 0
      return failCount >= CIRCUIT_THRESHOLD
    })

    if (circuitOpen) {
      logger.warn(`[OwnerRez:${userId}] Circuit breaker open — skipping connection sync`)
      return { skipped: 'circuit_open' }
    }

    // ── Check for properties added in OwnerRez since the last sync ──────────
    // getBookings() below only ever asks about properties FieldStay already
    // knows — a property added in OwnerRez (or restored after a reconnect)
    // was otherwise invisible until the PM noticed and clicked "Resync" by
    // hand. Re-firing the initial-sync event is safe: its steps no-op for
    // properties that are fully set up.
    if (orgId && checkNewProperties) {
      const newPropertyIds = await step.run('check-new-properties', async () => {
        const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
        try {
          const orProperties = await new OwnerRezApiClient(userId).getProperties()
          if (!orProperties.length) return []

          const { data: known } = await supabase
            .from('properties')
            .select('external_id')
            .eq('org_id', orgId)
            .eq('external_source', PROVIDER)

          const knownIds = new Set((known ?? []).map((p) => p.external_id))
          return orProperties
            .map((p) => String(p.id))
            .filter((id) => !knownIds.has(id))
        } catch (err) {
          logger.warn(`[OwnerRez:${userId}] new-property check failed: ${err instanceof Error ? err.message : String(err)}`)
          return []
        }
      })

      if (newPropertyIds.length) {
        logger.info(
          `[OwnerRez:${userId}] ${newPropertyIds.length} new propert` +
          `${newPropertyIds.length === 1 ? 'y' : 'ies'} found — re-running initial sync`
        )
        await step.sendEvent('fire-new-properties-sync', {
          name: 'integration/ownerrez.connected',
          data: {
            user_id:          userId,
            org_id:           orgId,
            external_user_id: event.data.external_user_id,
          },
        })
      }
    }

    type SyncSuccess = {
      affectedPropertyIds:    string[]
      bookingsToPostRevenue: { bookingId: string; propertyId: string; actualTotalAmount: number | null }[]
    }
    const syncResult: SyncSuccess | { skipped: boolean; reason: string } | null | undefined =
      await step.run('sync-connection', async () => {
        const supabase = createServiceClient({ system: 'inngest:incremental-sync' })

        // Re-fetch the connection: metadata (sync_cursor) and status may have
        // changed between dispatch and this run — a revoked/disconnected
        // connection must not be synced off a stale snapshot.
        const { data: conn } = await supabase
          .from('integration_connections')
          .select('id, user_id, org_id, external_user_id, metadata, status')
          .eq('id', connectionId)
          .maybeSingle()

        if (!conn || conn.status !== 'active') {
          return { skipped: true, reason: 'connection_not_active' }
        }

        const metadata = (conn.metadata ?? {}) as Record<string, unknown>
        const sinceUtc = (metadata['sync_cursor'] as string | undefined) ?? undefined
        const client   = new OwnerRezApiClient(userId)

        // When no cursor exists yet (e.g. fresh reconnect before initial sync sets one),
        // fall back to property_ids so OwnerRez receives at least one required parameter.
        let propertyIds: number[] | undefined
        if (!sinceUtc) {
          const { data: connectedProps } = await supabase
            .from('properties')
            .select('external_id')
            .eq('org_id', conn.org_id)
            .eq('external_source', PROVIDER)

          const ids = ((connectedProps ?? []) as Array<{ external_id: string | null }>)
            .map((p) => Number(p.external_id))
            .filter((id) => !Number.isNaN(id))

          if (!ids.length) {
            // No connected properties yet (initial sync hasn't run/completed) —
            // skip rather than calling OwnerRez with neither required param.
            console.log(`[OwnerRez:${userId}] No connected properties and no sync cursor — skipping`)
            return { skipped: true, reason: 'no_cursor_no_properties' }
          }
          propertyIds = ids
        }

        // MEDIUM-3: capture timestamp BEFORE the fetch to close the race window.
        // Bookings modified during the fetch have a modified_at between fetchStartedAt
        // and the end of the fetch. Using fetchStartedAt as the new cursor ensures
        // they are re-fetched on the next incremental run.
        const fetchStartedAt = new Date().toISOString()

        try {
          const bookings = await client.getBookings({ sinceUtc, propertyIds, includeGuest: true })

          let affectedPropertyIds: string[] = []
          let bookingsToPostRevenue: { bookingId: string; propertyId: string; actualTotalAmount: number | null }[] = []

          if (bookings.length) {
            // CRITICAL-2: resolve FieldStay property IDs from OwnerRez external IDs.
            // The previous code hardcoded property_id: null, overwriting the resolved
            // ID set by the initial sync on every incremental pass.
            const externalPropertyIds = [
              ...new Set(
                bookings
                  .map((b) => b.property_id)
                  .filter((id): id is number => id !== null)
                  .map(String)
              ),
            ]

            const externalToFsId: Record<string, string> = {}
            if (externalPropertyIds.length) {
              const { data: fsProps, error: propsLookupError } = await supabase
                .from('properties')
                .select('id, external_id')
                .eq('org_id', conn.org_id)
                .eq('external_source', PROVIDER)
                .in('external_id', externalPropertyIds)

              if (propsLookupError || !fsProps) {
                console.error(
                  `[OwnerRez sync] Property lookup failed for org ${conn.org_id} — ` +
                  `skipping booking upsert to prevent property_id null overwrite`,
                  propsLookupError?.message
                )
                reportError(
                  new Error(propsLookupError?.message ?? 'Property lookup returned no data'),
                  { site: 'inngest.ownerrez-connection-sync.property_lookup', orgId: conn.org_id },
                )
                return
              }

              for (const p of fsProps) {
                if (p.external_id) externalToFsId[p.external_id] = p.id
              }
            }

            const bookingRows = bookings.map((b) => buildOwnerRezBookingRow(conn.org_id, b, externalToFsId))

            const { data: upserted, error } = await supabase
              .from('bookings')
              .upsert(bookingRows, { onConflict: 'org_id,external_id,external_source' })
              .select('id, external_id')

            if (error) {
              logger.error(`[OwnerRez:${userId}] bookings upsert: ${error.message}`)
              throw new Error(error.message)
            }

            affectedPropertyIds = Array.from(new Set(
              bookingRows.map((b) => b.property_id).filter((id): id is string => id !== null)
            ))

            const idByExternalId = Object.fromEntries(
              (upserted ?? []).map((row) => [row.external_id, row.id as string])
            )

            bookingsToPostRevenue = selectOwnerRezBookingsToPostRevenue(bookingRows, idByExternalId)

            // Send immediate maintenance-suggestion notifications for owner blocks.
            // Blocks never generate turnovers (filtered at the generator query level),
            // but a known vacancy window is the best signal for scheduling maintenance.
            // Don't wait for the next cron cycle — notify the PM right away.
            type BookingRow = typeof bookingRows[number]
            const ownerBlocks = bookingRows.filter(
              (r): r is BookingRow & { property_id: string } =>
                Boolean(r.is_block) && r.property_id !== null
            )

            if (ownerBlocks.length) {
              // Batch-fetch property names for every owner-block property in one
              // query instead of a per-booking SELECT inside the loop.
              const uniquePropertyIds = [...new Set(ownerBlocks.map((b) => b.property_id))]

              const { data: blockProperties } = await supabase
                .from('properties')
                .select('id, name')
                .in('id', uniquePropertyIds)

              const propertyNameById = Object.fromEntries(
                (blockProperties ?? []).map((p) => [p.id, p.name as string | null])
              ) as Record<string, string | null>

              // Parallel sends — owner-block notifications are independent of each
              // other. One email failure must not abort the rest.
              await Promise.all(
                ownerBlocks.map(async (row) => {
                  try {
                    const candidates = await findMaintenanceCandidatesForWindow(
                      supabase,
                      row.property_id,
                      row.checkin_date,
                      row.checkout_date
                    )

                    if (!candidates.length) return

                    const propertyName = propertyNameById[row.property_id] ?? 'Property'

                    const items = candidates
                      .map((c) => `${c.name}${c.estimated_cost ? ` (~$${c.estimated_cost})` : ''}`)
                      .join(', ')

                    await createPmNotification(supabase, {
                      orgId:     conn.org_id,
                      type:      'maintenance_opportunity',
                      title:     `Maintenance opportunity — ${propertyName} blocked for owner use`,
                      subtitle:  `Blocked ${new Date(row.checkin_date).toLocaleDateString()} – ${new Date(row.checkout_date).toLocaleDateString()}. Candidates: ${items}`,
                      href:      '/maintenance',
                      severity:  'blue',
                      dedupeKey: `ownerrez-maint-opportunity-${row.external_id}`,
                    })
                  } catch (err) {
                    logger.error(
                      `[OwnerRez] Failed to send owner-block email for booking ${row.external_id}: ${err instanceof Error ? err.message : String(err)}`
                    )
                    // Non-fatal — log and continue; don't fail the whole step for one email
                  }
                })
              )
            }
          }

          // MEDIUM-3: use pre-fetch timestamp as cursor — not post-fetch
          try {
            await mergeIntegrationConnectionMetadata({
              userId:     conn.user_id,
              providerId: PROVIDER,
              patch: {
                sync_cursor:      fetchStartedAt,
                last_synced_at:   new Date().toISOString(),
                last_sync_status: 'success',
                last_sync_error:  null,
                last_sync_count:  bookings.length,
              },
            })
          } catch (cursorErr) {
            // Non-fatal: data was written correctly; log and continue
            logger.error(`[OwnerRez:${userId}] cursor update failed: ${cursorErr instanceof Error ? cursorErr.message : String(cursorErr)}`)
          }

          logger.info(`[OwnerRez:${userId}] sync complete — ${bookings.length} bookings`, {
            bookingCount: bookings.length,
          })

          // Reset circuit breaker on success
          try {
            const redis = getRedis()
            await redis.del(CIRCUIT_KEY)
          } catch { /* non-fatal */ }

          return { affectedPropertyIds, bookingsToPostRevenue }

        } catch (err) {
          if (err instanceof RateLimitError) {
            // The shared-IP budget (or this connection's fair share of it)
            // is exhausted. Write transient status, then RETHROW so Inngest
            // retries this step with backoff — the 5-minute budget window
            // rolls well within the retry schedule, so this connection
            // resumes on its own instead of parking until the next hourly
            // cron. Other connections run independently and are unaffected
            // (this was the old serial loop's `break`-the-whole-tick
            // failure mode).
            logger.warn(`[OwnerRez:${userId}] Rate limited (retry after ${err.retryAfter}s) — will retry with backoff`)

            // Write transient rate-limit status — don't change connection status to 'error'
            await mergeIntegrationConnectionMetadata({
              userId:     conn.user_id,
              providerId: PROVIDER,
              patch: {
                last_sync_status: 'rate_limited',
                last_sync_error:  translateSyncError(err),
              },
            })

            throw err
          }

          if (err instanceof TokenRevokedError) {
            const humanError = translateSyncError(err)
            logger.error(`[OwnerRez:${userId}] Token revoked — marking connection as revoked`)

            await mergeIntegrationConnectionMetadata({
              userId:     conn.user_id,
              providerId: PROVIDER,
              patch: {
                last_sync_status: 'error',
                last_sync_error:  humanError,
                last_synced_at:   new Date().toISOString(),
              },
              status: 'revoked',
            })

            await logAuditEvent({
              orgId:      conn.org_id,
              action:     'integration.sync_failed',
              targetType: 'integration_connection',
              targetId:   conn.id,
              metadata:   { provider_id: PROVIDER, reason: 'token_revoked' },
            })

            await notifyConnectionErrorThrottled(supabase, conn.id, userId, conn.org_id, humanError)

            // MEDIUM-6: token revocation is permanent — retrying will only hit
            // the same revoked token again. NonRetriableError (after the side
            // effects above already completed) records this as a distinct
            // non-retriable failure in Inngest's dashboard. With one
            // connection per run, nothing else is blocked by it.
            throw new NonRetriableError(humanError)
          }

          const humanError = translateSyncError(err)
          logger.error(
            `[OwnerRez:${userId}] sync failed: ${err instanceof Error ? err.message : String(err)}`
          )

          await mergeIntegrationConnectionMetadata({
            userId:     conn.user_id,
            providerId: PROVIDER,
            patch: {
              last_sync_status: 'error',
              last_sync_error:  humanError,
              last_synced_at:   new Date().toISOString(),
            },
            status: 'error',
          })

          await logAuditEvent({
            orgId:      conn.org_id,
            action:     'integration.sync_failed',
            targetType: 'integration_connection',
            targetId:   conn.id,
            metadata:   { provider_id: PROVIDER, error: humanError },
          })

          // Increment circuit breaker counter (expires in 30 minutes)
          try {
            const redis    = getRedis()
            const newCount = await redis.incr(CIRCUIT_KEY)
            if (newCount === 1) await redis.expire(CIRCUIT_KEY, 30 * 60)
          } catch { /* non-fatal */ }

          await notifyConnectionErrorThrottled(supabase, conn.id, userId, conn.org_id, humanError)
        }
      })

    const affectedIds = syncResult && 'affectedPropertyIds' in syncResult
      ? syncResult.affectedPropertyIds
      : []

    // Post booking revenue for newly-confirmed guest-stay bookings. Mirrors
    // Hospitable's incremental-sync pattern: sendEvent happens at the top
    // level of the function body, never nested inside step.run.
    // actual_total_amount now comes from extractOwnerRezActualTotal
    // (charges[].owner_amount / total_amount, confirmed live 2026-07-15);
    // booking-events.ts's handleBookingConfirmed still falls back to the
    // avg_nightly_rate estimate whenever it's null.
    const bookingsToPostRevenue = syncResult && 'bookingsToPostRevenue' in syncResult
      ? syncResult.bookingsToPostRevenue
      : []
    if (bookingsToPostRevenue.length > 0 && orgId) {
      await step.sendEvent(
        'post-booking-revenue',
        bookingsToPostRevenue.map((b) => ({
          name: 'booking/confirmed' as const,
          data: {
            booking_id:          b.bookingId,
            property_id:         b.propertyId,
            org_id:              orgId,
            source:              'ownerrez' as const,
            actual_total_amount: b.actualTotalAmount,
          },
        }))
      )
    }

    // Generate turnovers for any properties that received booking updates.
    // Called once per property (not per booking) so the generator sees the
    // full booking list and can apply its two-pass pairing logic correctly.
    if (affectedIds.length && orgId) {
      const allNewTurnoverIds = await step.run('generate-turnovers', async () => {
        const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
        const ids: string[] = []
        for (const propertyId of affectedIds) {
          try {
            const newIds = await generateTurnoversForProperty(propertyId, orgId, supabase)
            ids.push(...newIds)
          } catch (err) {
            logger.error(
              `[OwnerRez:${userId}] Turnover generation failed for property ${propertyId}: ${err}`
            )
            // Don't let one property's failure block the others
          }
        }
        return ids
      })

      if (allNewTurnoverIds.length > 0) {
        const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
          const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
          type TurnoverRow = { id: string; property_id: string; checkout_datetime: string; checkin_datetime: string; window_minutes: number | null }
          const { data: turnovers } = await supabase
            .from('turnovers')
            .select('id, property_id, checkout_datetime, checkin_datetime, window_minutes')
            .in('id', allNewTurnoverIds)

          return (turnovers as TurnoverRow[] ?? []).map((t) => ({
            name: 'turnover/created' as const,
            data: {
              turnover_id:       t.id,
              property_id:       t.property_id,
              org_id:            orgId,
              checkout_datetime: t.checkout_datetime,
              checkin_datetime:  t.checkin_datetime,
              window_minutes:    t.window_minutes ?? 0,
            },
          }))
        })

        if (turnoverEvents.length > 0) {
          await step.sendEvent('fire-turnover-created-events', turnoverEvents)
        }
      }

      // Auto-create guidebook property configs for newly synced properties
      await step.run('create-guidebook-property-configs', async () => {
        try {
          await createGuidebookPropertyConfigsForProperties(orgId, affectedIds)
        } catch (err) {
          logger.error(`[OwnerRez:${userId}] guidebook config creation failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })

      // No-op until amenities data exists for these properties (this file
      // doesn't currently fetch property details — see the TODO above), but
      // included for parity so it activates automatically once it does.
      await step.run('seed-present-assets-from-amenities', async () => {
        try {
          await seedPresentAssetsFromAmenities(orgId, affectedIds)
        } catch (err) {
          logger.error(`[OwnerRez:${userId}] present-asset seeding failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    }

    const synced = Boolean(syncResult && 'affectedPropertyIds' in syncResult)
    return { connectionId, synced }
  }
)

/**
 * Fire a PM notification about a broken connection — throttled to once per
 * 4 hours per connection via an org_milestones timestamp. Shared by the
 * token-revoked and generic-error paths (previously duplicated inline).
 * Runs inside the sync step, so failures here are deliberately swallowed:
 * connection status/metadata were already written.
 */
async function notifyConnectionErrorThrottled(
  supabase: ReturnType<typeof createServiceClient>,
  connectionId: string,
  userId: string,
  orgId: string | null,
  humanError: string
): Promise<void> {
  try {
    const milestoneKey = `integration_error_notified:${connectionId}`
    const { data: recentNotification } = await supabase
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
      // Revoked tokens are the most important case to notify on: only the PM
      // can fix them by reconnecting, and they never self-resolve on retry.
      await inngest.send({
        name: 'integration/connection.error',
        data: {
          user_id:     userId,
          org_id:      orgId ?? '',
          provider_id: PROVIDER,
          reason:      humanError,
        },
      })
      await supabase.from('org_milestones').upsert({
        org_id:    orgId,
        milestone: milestoneKey,
        value:     { notified_at: new Date().toISOString() },
      }, { onConflict: 'org_id,milestone' })
    }
  } catch { /* non-fatal — connection status was already written */ }
}
