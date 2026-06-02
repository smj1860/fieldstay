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
 *  3. Upsert results
 *  4. Update sync_cursor and last_synced_at
 *
 * Each user runs in its own step.run() so failures are isolated.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient }   from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError } from '@/lib/integrations/types'

const PROVIDER = 'ownerrez'

export const ownerRezIncrementalSync = inngest.createFunction(
  {
    id:      'ownerrez-incremental-sync',
    name:    'OwnerRez Incremental Sync',
    retries: 3,
    concurrency: { limit: 5 },
  },
  [
    { cron: '0/15 * * * *' },
    { event: 'integration/ownerrez.sync.requested' as const },
  ],
  async ({ step, logger }) => {
    const supabase = createServiceClient()

    // Fetch all active OwnerRez connections
    const { data: connections } = await supabase
      .from('integration_connections')
      .select('id, user_id, org_id, metadata')
      .eq('provider_id', PROVIDER)
      .eq('status', 'active')

    if (!connections?.length) {
      logger.info('[OwnerRez] No active connections to sync')
      return { synced: 0 }
    }

    let syncedCount = 0

    for (const conn of connections) {
      await step.run(`sync-user-${conn.user_id}`, async () => {
        const metadata   = (conn.metadata ?? {}) as Record<string, unknown>
        const sinceUtc   = (metadata['sync_cursor'] as string | undefined) ?? undefined
        const client     = new OwnerRezApiClient(conn.user_id)

        try {
          // Fetch bookings since cursor (include_guest captures name/email directly)
          const bookings = await client.getBookings({ sinceUtc, includeGuest: true })

          if (bookings.length) {
            const bookingRows = bookings.map((b) => ({
              org_id:          conn.org_id,
              property_id:     null as string | null,
              guest_name:      b.guest?.name  ?? null,
              guest_email:     b.guest?.email ?? null,
              checkin_date:    b.arrival,
              checkout_date:   b.departure,
              source:          mapChannelToSource(b.channel_name),
              status:          mapBookingStatus(b.status),
              external_id:     String(b.id),
              external_source: PROVIDER,
            }))

            const { error } = await supabase
              .from('bookings')
              .upsert(bookingRows, { onConflict: 'external_id,external_source' })

            if (error) {
              logger.error(`[OwnerRez:${conn.user_id}] bookings upsert: ${error.message}`)
              throw new Error(error.message)
            }
          }

          // Update sync cursor
          await supabase
            .from('integration_connections')
            .update({
              metadata: {
                ...metadata,
                sync_cursor:    new Date().toISOString(),
                last_synced_at: new Date().toISOString(),
              },
            })
            .eq('id', conn.id)

          logger.info(
            `[OwnerRez:${conn.user_id}] sync complete — ${bookings.length} bookings`
          )
          syncedCount++

        } catch (err) {
          if (err instanceof RateLimitError) {
            logger.warn(`[OwnerRez:${conn.user_id}] Rate limited — retry after ${err.retryAfter}s`)
            await step.sleep(`rate-limit-${conn.user_id}`, `${err.retryAfter}s`)
            throw err // Inngest will retry this step
          }
          logger.error(
            `[OwnerRez:${conn.user_id}] sync failed: ${err instanceof Error ? err.message : String(err)}`
          )
          // Mark connection as error so UI reflects the issue
          await supabase
            .from('integration_connections')
            .update({ status: 'error' })
            .eq('id', conn.id)
        }
      })
    }

    return { synced: syncedCount, total: connections.length }
  }
)

// ── Data mapping helpers ──────────────────────────────────────────────────────

function mapBookingStatus(status: string): string {
  const s = status.toLowerCase()
  if (s === 'confirmed') return 'confirmed'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'tentative') return 'tentative'
  return 'confirmed'
}

function mapChannelToSource(channel?: string): string {
  if (!channel) return 'other'
  const c = channel.toLowerCase()
  if (c.includes('airbnb'))                         return 'airbnb'
  if (c.includes('vrbo') || c.includes('homeaway')) return 'vrbo'
  if (c.includes('booking'))                        return 'booking_com'
  if (c.includes('direct'))                         return 'direct'
  return 'other'
}
