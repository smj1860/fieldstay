/**
 * OwnerRez Incremental Sync
 *
 * Triggered by:
 *  - Inngest cron:    every 15 minutes  (0/15 * * * *)
 *  - Webhook event:   integration/ownerrez.sync.requested
 *
 * For each active OwnerRez connection:
 *  1. Read sync_cursor from metadata
 *  2. Fetch bookings + guests since cursor using since_utc
 *  3. Resolve FieldStay property_id from OwnerRez property external IDs
 *  4. Upsert results
 *  5. Update sync_cursor (using pre-fetch timestamp) and last_synced_at
 *
 * Each user runs in its own step.run() so failures are isolated.
 * step.sleep() is called at the TOP LEVEL only — never inside step.run().
 */

import { inngest }                      from '@/lib/inngest/client'
import { createServiceClient }          from '@/lib/supabase/server'
import { OwnerRezApiClient, getRedis }  from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import { logAuditEvent }                from '@/lib/audit'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { resend, FROM }                 from '@/lib/resend/client'
import { getPmEmail }                   from '@/lib/inngest/helpers'
import { findMaintenanceCandidatesForWindow } from '@/lib/maintenance/vacancy-suggestions'

const PROVIDER = 'ownerrez'

export const ownerRezIncrementalSync = inngest.createFunction(
  {
    id:          'ownerrez-incremental-sync',
    name:        'OwnerRez Incremental Sync',
    retries:     3,
    concurrency: { limit: 5 },
  },
  [
    { cron: '0/15 * * * *' },
    { event: 'integration/ownerrez.sync.requested' as const },
    { event: 'ownerrez/sync.now.requested' as const },
  ],
  async ({ step, logger }) => {
    const workflowId = crypto.randomUUID()
    logger.info('ownerrez-incremental-sync triggered', { workflowId, trigger: 'cron' })

    // Circuit breaker: if the OwnerRez API is degraded, skip this cron tick.
    const circuitOpen = await step.run('check-circuit-breaker', async () => {
      const redis    = getRedis()
      const failCount = await redis.get<number>('ownerrez:circuit:consecutive_failures') ?? 0
      return failCount >= 10
    })

    if (circuitOpen) {
      logger.warn('[OwnerRez] Circuit breaker open — skipping cron tick, waiting for recovery')
      return { synced: 0, circuit_open: true }
    }

    const connections = await step.run('fetch-connections', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('integration_connections')
        .select('id, user_id, org_id, metadata')
        .eq('provider_id', PROVIDER)
        .eq('status', 'active')
      return data ?? []
    })

    if (!connections.length) {
      logger.info('[OwnerRez] No active connections to sync')
      return { synced: 0 }
    }

    let syncedCount = 0

    for (const conn of connections) {
      // HIGH-1: rateLimited flag set inside step.run; sleep called outside
      let rateLimited       = false
      let retryAfterSeconds = 60

      const syncResult = await step.run(`sync-user-${conn.user_id}`, async () => {
        const supabase = createServiceClient()
        const metadata = (conn.metadata ?? {}) as Record<string, unknown>
        const sinceUtc = (metadata['sync_cursor'] as string | undefined) ?? undefined
        const client   = new OwnerRezApiClient(conn.user_id)

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
            console.log(`[OwnerRez:${conn.user_id}] No connected properties and no sync cursor — skipping`)
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

          if (bookings.length) {
            // CRITICAL-2: resolve FieldStay property IDs from OwnerRez external IDs.
            // The previous code hardcoded property_id: null, overwriting the resolved
            // ID set by the initial sync on every incremental pass.
            const externalPropertyIds = [
              ...new Set(
                bookings
                  .map((b) => b.property_id)
                  .filter((id): id is number => id != null)
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
                return
              }

              for (const p of fsProps) {
                if (p.external_id) externalToFsId[p.external_id] = p.id
              }
            }

            const bookingRows = bookings.map((b) => ({
              org_id:          conn.org_id,
              property_id:     b.property_id != null
                                 ? (externalToFsId[String(b.property_id)] ?? null)
                                 : null,
              guest_name:      b.guest?.name  ?? null,
              guest_email:     b.guest?.email ?? null,
              checkin_date:    b.arrival,
              checkout_date:   b.departure,
              source:          mapChannelToSource(b.channel_name),
              status:          mapBookingStatus(b.status),
              external_id:     String(b.id),
              external_source: PROVIDER,
              is_block:        b.is_block ?? false,
            }))

            const { error } = await supabase
              .from('bookings')
              .upsert(bookingRows, { onConflict: 'external_id,external_source' })

            if (error) {
              logger.error(`[OwnerRez:${conn.user_id}] bookings upsert: ${error.message}`)
              throw new Error(error.message)
            }

            affectedPropertyIds = Array.from(new Set(
              bookingRows.map((b) => b.property_id).filter((id): id is string => id != null)
            ))

            // Send immediate maintenance-suggestion emails for owner blocks.
            // Blocks never generate turnovers (filtered at the generator query level),
            // but a known vacancy window is the best signal for scheduling maintenance.
            // Don't wait for the next cron cycle — notify the PM right away.
            const pmEmail = await getPmEmail(supabase, conn.org_id)
            if (pmEmail) {
              for (const row of bookingRows) {
                if (!row.is_block || !row.property_id) continue

                const candidates = await findMaintenanceCandidatesForWindow(
                  supabase,
                  row.property_id,
                  row.checkin_date,
                  row.checkout_date
                )

                if (!candidates.length) continue

                const { data: property } = await supabase
                  .from('properties')
                  .select('name')
                  .eq('id', row.property_id)
                  .single()

                const items = candidates
                  .map((c) => `${c.name}${c.estimated_cost ? ` (~$${c.estimated_cost})` : ''}`)
                  .join(', ')

                await resend.emails.send({
                  from:    FROM,
                  to:      pmEmail,
                  subject: `Maintenance opportunity — ${property?.name ?? 'Property'} blocked for owner use`,
                  html: `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                      <h2>Owner block scheduled</h2>
                      <p>
                        ${property?.name ?? 'This property'} is blocked
                        ${new Date(row.checkin_date).toLocaleDateString()} –
                        ${new Date(row.checkout_date).toLocaleDateString()}.
                        Want to schedule maintenance during this window? Candidates:
                        ${items}.
                      </p>
                      <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/maintenance" style="background:#093b31;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">Review Maintenance →</a></p>
                    </div>
                  `,
                })
              }
            }
          }

          // MEDIUM-3: use pre-fetch timestamp as cursor — not post-fetch
          const { error: cursorErr } = await supabase
            .from('integration_connections')
            .update({
              metadata: {
                ...metadata,
                sync_cursor:       fetchStartedAt,
                last_synced_at:    new Date().toISOString(),
                last_sync_status:  'success',
                last_sync_error:   null,
                last_sync_count:   bookings.length,
              },
            })
            .eq('id', conn.id)

          if (cursorErr) {
            // Non-fatal: data was written correctly; log and continue
            logger.error(`[OwnerRez:${conn.user_id}] cursor update failed: ${cursorErr.message}`)
          }

          logger.info(`[OwnerRez:${conn.user_id}] sync complete — ${bookings.length} bookings`, {
            workflowId,
            bookingCount: bookings.length,
          })
          syncedCount++

          // Reset circuit breaker on success
          try {
            const redis = getRedis()
            await redis.del('ownerrez:circuit:consecutive_failures')
          } catch { /* non-fatal */ }

          return affectedPropertyIds

        } catch (err) {
          if (err instanceof RateLimitError) {
            // HIGH-1: do NOT call step.sleep here — step primitives cannot be nested
            // inside step.run. Set a flag; sleep is called at the top level below.
            rateLimited       = true
            retryAfterSeconds = err.retryAfter
            logger.warn(`[OwnerRez:${conn.user_id}] Rate limited — sleeping ${err.retryAfter}s`)

            // Write transient rate-limit status — don't change connection status to 'error'
            await supabase
              .from('integration_connections')
              .update({
                metadata: {
                  ...metadata,
                  last_sync_status: 'rate_limited',
                  last_sync_error:  translateSyncError(err),
                },
              })
              .eq('id', conn.id)

            return  // exit this step cleanly without failing it
          }

          if (err instanceof TokenRevokedError) {
            const humanError = translateSyncError(err)
            logger.error(`[OwnerRez:${conn.user_id}] Token revoked — marking connection as revoked`)

            await supabase
              .from('integration_connections')
              .update({
                status:   'revoked',
                metadata: {
                  ...metadata,
                  last_sync_status: 'error',
                  last_sync_error:  humanError,
                  last_synced_at:   new Date().toISOString(),
                },
              })
              .eq('id', conn.id)

            await logAuditEvent({
              orgId:      conn.org_id,
              action:     'integration.sync_failed',
              targetType: 'integration_connection',
              targetId:   conn.id,
              metadata:   { provider_id: PROVIDER, reason: 'token_revoked' },
            })

            // Fire PM notification — throttled to once per 4 hours per connection.
            // Revoked tokens are the most important case to notify on: only the PM
            // can fix them by reconnecting, and they never self-resolve on retry.
            try {
              const milestoneKey = `integration_error_notified:${conn.id}`
              const { data: recentNotification } = await supabase
                .from('org_milestones')
                .select('value, achieved_at')
                .eq('org_id', conn.org_id)
                .eq('milestone', milestoneKey)
                .order('achieved_at', { ascending: false })
                .limit(1)
                .maybeSingle()

              const lastNotifiedAt = (recentNotification?.value as Record<string, unknown> | null)
                ?.notified_at
              const tooSoon = lastNotifiedAt &&
                Date.now() - new Date(lastNotifiedAt as string).getTime() < 4 * 60 * 60 * 1000

              if (!tooSoon) {
                await step.sendEvent('notify-revoked-connection', {
                  name: 'integration/connection.error',
                  data: {
                    user_id:     conn.user_id,
                    org_id:      conn.org_id ?? '',
                    provider_id: PROVIDER,
                    reason:      humanError,
                  },
                })
                await supabase.from('org_milestones').upsert({
                  org_id:    conn.org_id,
                  milestone: milestoneKey,
                  value:     { notified_at: new Date().toISOString() },
                }, { onConflict: 'org_id,milestone' })
              }
            } catch { /* non-fatal — connection status was already written */ }

            return  // exit this step cleanly; connection is dead, no retry needed
          }

          const humanError = translateSyncError(err)
          logger.error(
            `[OwnerRez:${conn.user_id}] sync failed: ${err instanceof Error ? err.message : String(err)}`
          )

          await supabase
            .from('integration_connections')
            .update({
              status:   'error',
              metadata: {
                ...metadata,
                last_sync_status: 'error',
                last_sync_error:  humanError,
                last_synced_at:   new Date().toISOString(),
              },
            })
            .eq('id', conn.id)

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
            const key      = 'ownerrez:circuit:consecutive_failures'
            const newCount = await redis.incr(key)
            if (newCount === 1) await redis.expire(key, 30 * 60)
          } catch { /* non-fatal */ }

          // Fire PM notification — throttled to once per 4 hours per connection
          try {
            const milestoneKey = `integration_error_notified:${conn.id}`
            const { data: recentNotification } = await supabase
              .from('org_milestones')
              .select('value, achieved_at')
              .eq('org_id', conn.org_id)
              .eq('milestone', milestoneKey)
              .order('achieved_at', { ascending: false })
              .limit(1)
              .maybeSingle()

            const lastNotifiedAt = (recentNotification?.value as Record<string, unknown> | null)
              ?.notified_at
            const tooSoon = lastNotifiedAt &&
              Date.now() - new Date(lastNotifiedAt as string).getTime() < 4 * 60 * 60 * 1000

            if (!tooSoon) {
              await step.sendEvent('notify-connection-error', {
                name: 'integration/connection.error',
                data: {
                  user_id:     conn.user_id,
                  org_id:      conn.org_id ?? '',
                  provider_id: PROVIDER,
                  reason:      humanError,
                },
              })
              await supabase.from('org_milestones').upsert({
                org_id:    conn.org_id,
                milestone: milestoneKey,
                value:     { notified_at: new Date().toISOString() },
              }, { onConflict: 'org_id,milestone' })
            }
          } catch { /* non-fatal — data was already written to metadata */ }
        }
      })

      // Generate turnovers for any properties that received booking updates.
      // Called once per property (not per booking) so the generator sees the
      // full booking list and can apply its two-pass pairing logic correctly.
      const affectedIds = Array.isArray(syncResult) ? syncResult : []
      if (affectedIds.length) {
        await step.run(`generate-turnovers-${conn.user_id}`, async () => {
          const supabase = createServiceClient()
          for (const propertyId of affectedIds) {
            try {
              await generateTurnoversForProperty(propertyId, conn.org_id, supabase)
            } catch (err) {
              logger.error(
                `[OwnerRez:${conn.user_id}] Turnover generation failed for property ${propertyId}: ${err}`
              )
              // Don't let one property's failure block the others
            }
          }
        })
      }

      // HIGH-1: step.sleep called at top level — NOT inside step.run
      if (rateLimited) {
        await step.sleep(
          `rate-limit-backoff-${conn.user_id}`,
          `${retryAfterSeconds}s`   // string duration, NOT milliseconds
        )
      }
    }

    return { synced: syncedCount, total: connections.length }
  }
)

// ── Data mapping helpers ──────────────────────────────────────────────────────

function mapBookingStatus(status: string): string {
  const s = status.toLowerCase()
  if (s === 'confirmed')                     return 'confirmed'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'tentative')                     return 'tentative'
  return 'confirmed'
}

function mapChannelToSource(channel?: string): string {
  if (!channel) return 'other'
  const c = channel.toLowerCase()
  if (c.includes('airbnb'))                          return 'airbnb'
  if (c.includes('vrbo') || c.includes('homeaway')) return 'vrbo'
  if (c.includes('booking'))                        return 'booking_com'
  if (c.includes('direct'))                         return 'direct'
  return 'other'
}
