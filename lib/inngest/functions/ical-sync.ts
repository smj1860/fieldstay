import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { parseIcalFeed, toDateString, toTimeString, isAllDay } from '@/lib/ical/parser'
import { generateTurnoversForProperty, cancelTurnoversForBooking } from '@/lib/turnovers/generator'

// H-2: Reject non-HTTPS URLs and private/loopback IP ranges to prevent SSRF
function assertSafeIcalUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid iCal URL format')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('iCal feeds must use HTTPS')
  }
  const h = parsed.hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') {
    throw new Error('SSRF: loopback address not permitted')
  }
  if (/^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h)) {
    throw new Error('SSRF: private IP range not permitted')
  }
  // Block AWS metadata endpoint and link-local
  if (/^169\.254\./.test(h)) {
    throw new Error('SSRF: link-local address not permitted')
  }
}

/**
 * SCHEDULED: runs every 4 hours.
 * Also triggered manually via `ical/sync.all.requested`.
 *
 * Fetches all active iCal feeds and fans out one sync event per feed.
 */
export const syncAllIcalFeeds = inngest.createFunction(
  {
    id:          'ical-sync-all',
    name:        'Sync All iCal Feeds',
    concurrency: { limit: 1 },  // only one full sync at a time
  },
  [
    { cron: '0 * * * *' },                        // every hour
    { event: 'ical/sync.all.requested' as const },
  ],
  async ({ step, logger }) => {
    const feeds = await step.run('fetch-active-feeds', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('ical_feeds')
        .select('id, property_id, org_id')
        .eq('is_active', true)

      if (error) throw new Error(`Failed to fetch feeds: ${error.message}`)
      return data ?? []
    })

    logger.info(`Syncing ${feeds.length} iCal feeds`)

    if (feeds.length === 0) return { synced: 0 }

    // Fan out — one event per feed, spread across 55-minute window to prevent thundering herd
    const JITTER_WINDOW_MS = 55 * 60 * 1000

    await step.sendEvent(
      'fan-out-feed-syncs',
      feeds.map((feed, index) => {
        const baseDelay    = feeds.length > 1
          ? Math.floor((index / (feeds.length - 1)) * JITTER_WINDOW_MS)
          : 0
        const randomJitter = Math.floor(Math.random() * 30_000)
        const scheduledTs  = Date.now() + baseDelay + randomJitter

        return {
          name: 'ical/sync.requested' as const,
          data: {
            feed_id:     feed.id,
            property_id: feed.property_id,
            org_id:      feed.org_id,
          },
          ts: scheduledTs,
        }
      })
    )

    return { synced: feeds.length }
  }
)

/**
 * Triggered per-feed by `syncAllIcalFeeds` or directly.
 *
 * Steps:
 *  1. Fetch raw iCal data from the feed URL
 *  2. Parse into booking events
 *  3. Upsert bookings (insert new, update changed, mark removed as cancelled)
 *  4. Generate turnovers from consecutive booking gaps
 *  5. Fire `booking/detected` for any new confirmed bookings
 *  6. Update feed sync status
 */
export const syncIcalFeed = inngest.createFunction(
  {
    id:      'ical-sync-feed',
    name:    'Sync iCal Feed',
    // Allow up to 20 feeds syncing in parallel
    concurrency: { limit: 5 },
    // Retry up to 2 times on network errors
    retries: 2,
  },
  { event: 'ical/sync.requested' as const },
  async ({ event, step, logger }) => {
    const { feed_id, property_id, org_id } = event.data

    // ── Step 1: Fetch feed URL and raw data ─────────────────────────────────

    const feedUrl = await step.run('fetch-feed-url', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('ical_feeds')
        .select('url')
        .eq('id', feed_id)
        .single()

      if (error || !data) throw new Error(`Feed not found: ${feed_id}`)
      return data.url
    })

    let rawIcal: string
    try {
      rawIcal = await step.run('download-ical', async () => {
        assertSafeIcalUrl(feedUrl)
        const response = await fetch(feedUrl, {
          headers: { 'User-Agent': 'FieldStay/1.0 iCal Sync' },
          signal:  AbortSignal.timeout(15_000),
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching iCal feed`)
        }
        return response.text()
      })
    } catch (err) {
      // Mark feed as errored and exit cleanly (don't retry fetch errors)
      const supabase = createServiceClient()
      await supabase.from('ical_feeds').update({
        last_synced_at:   new Date().toISOString(),
        last_sync_status: 'error',
        last_sync_error:  err instanceof Error ? err.message : 'Unknown error',
      }).eq('id', feed_id)

      logger.error(`Feed ${feed_id} fetch failed: ${err}`)
      return { success: false, error: String(err) }
    }

    // ── Step 2: Parse iCal data ──────────────────────────────────────────────

    const parsedEvents = await step.run('parse-ical', () => {
      return parseIcalFeed(rawIcal)
    })

    logger.info(`Parsed ${parsedEvents.length} events from feed ${feed_id}`)

    // ── Step 3: Upsert bookings ──────────────────────────────────────────────

    const { newBookings, cancelledBookingIds } = await step.run(
      'upsert-bookings',
      async (): Promise<{ newBookings: Array<{ id: string; guestEmail: string | null }>; cancelledBookingIds: string[] }> => {
      const supabase = createServiceClient()
      // Fetch existing bookings for this feed
      const { data: existingBookings } = await supabase
        .from('bookings')
        .select('id, ical_uid, status, guest_email')
        .eq('ical_feed_id', feed_id)

      const existingByUid = new Map(existingBookings?.map((b) => [b.ical_uid, b]) ?? [])
      const seenUids      = new Set<string>()
      const newBookingRows: Array<{ id: string; guestEmail: string | null }> = []
      const cancelledIds: string[] = []

      for (const event of parsedEvents) {
        seenUids.add(event.uid)

        const status =
          event.status === 'cancelled' ? 'cancelled' :
          event.status === 'blocked'   ? 'blocked'   :
          event.status === 'tentative' ? 'tentative' : 'confirmed'

        const checkinDate  = toDateString(event.start)
        const checkoutDate = toDateString(event.end)

        // Extract times only if not an all-day event
        const checkinTime  = isAllDay(event.start) ? null : toTimeString(event.start)
        const checkoutTime = isAllDay(event.end)   ? null : toTimeString(event.end)

        const existing = existingByUid.get(event.uid)

        if (existing) {
          // Update if anything changed
          await supabase
            .from('bookings')
            .update({
              guest_name:    event.guestName,
              checkin_date:  checkinDate,
              checkout_date: checkoutDate,
              checkin_time:  checkinTime,
              checkout_time: checkoutTime,
              status,
              raw_ical_data: { summary: event.guestName, uid: event.uid },
            })
            .eq('id', existing.id)

          // Track newly cancelled bookings
          if (status === 'cancelled' && existing.status !== 'cancelled') {
            cancelledIds.push(existing.id)
          }
        } else {
          // Upsert new booking — safe if two concurrent syncs race on the same ical_uid
          const { data: newBooking } = await supabase
            .from('bookings')
            .upsert({
              property_id:  property_id,
              org_id:       org_id,
              ical_feed_id: feed_id,
              ical_uid:     event.uid,
              guest_name:   event.guestName,
              guest_email:  null,  // iCal rarely includes email
              checkin_date:  checkinDate,
              checkout_date: checkoutDate,
              checkin_time:  checkinTime,
              checkout_time: checkoutTime,
              source:        'airbnb',  // refined from feed source if needed
              status,
              raw_ical_data: { summary: event.guestName, uid: event.uid },
            }, { onConflict: 'ical_feed_id,ical_uid', ignoreDuplicates: false })
            .select('id')
            .single()

          if (newBooking && status === 'confirmed') {
            newBookingRows.push({ id: newBooking.id, guestEmail: null })
          }
        }
      }

      // Mark bookings not present in latest feed as cancelled
      // (only confirmed/tentative — don't flip already-cancelled ones)
      for (const [uid, existing] of existingByUid.entries()) {
        if (!seenUids.has(uid) && existing.status === 'confirmed') {
          await supabase
            .from('bookings')
            .update({ status: 'cancelled' })
            .eq('id', existing.id)

          cancelledIds.push(existing.id)
        }
      }

      return { newBookings: newBookingRows, cancelledBookingIds: cancelledIds }
      }
    )

    // ── Step 4: Cancel turnovers for any cancelled bookings ─────────────────

    if (cancelledBookingIds.length > 0) {
      await step.run('cancel-affected-turnovers', async () => {
        const supabase = createServiceClient()
        for (const bookingId of cancelledBookingIds) {
          await cancelTurnoversForBooking(bookingId, supabase)
        }
      })
    }

    // ── Step 5: Generate turnovers from gaps between bookings ────────────────

    const newTurnoverIds = await step.run('generate-turnovers', async () => {
      const supabase = createServiceClient()
      return generateTurnoversForProperty(property_id, org_id, supabase)
    })

    logger.info(`Generated ${newTurnoverIds.length} new turnovers for property ${property_id}`)

    // ── Step 6: Fire downstream events ──────────────────────────────────────

    const eventsToSend: Parameters<typeof step.sendEvent>[1] = []
    const supabase = createServiceClient()

    // One `booking/detected` per new confirmed booking
    if (newBookings.length > 0) {
      // Fetch full booking data for the events
      const { data: bookingDetails } = await supabase
        .from('bookings')
        .select('id, guest_name, guest_email, checkin_date, checkout_date')
        .in('id', newBookings.map((b) => b.id))

      for (const booking of bookingDetails ?? []) {
        eventsToSend.push({
          name: 'booking/detected' as const,
          data: {
            booking_id:    booking.id,
            property_id,
            org_id,
            guest_name:    booking.guest_name,
            guest_email:   booking.guest_email,
            checkin_date:  booking.checkin_date,
            checkout_date: booking.checkout_date,
          },
        })
      }
    }

    // One `turnover/created` per new turnover
    for (const turnover_id of newTurnoverIds) {
      const { data: t } = await supabase
        .from('turnovers')
        .select('checkout_datetime, checkin_datetime, window_minutes')
        .eq('id', turnover_id)
        .single()

      if (t) {
        eventsToSend.push({
          name: 'turnover/created' as const,
          data: {
            turnover_id,
            property_id,
            org_id,
            checkout_datetime: t.checkout_datetime,
            checkin_datetime:  t.checkin_datetime,
            window_minutes:    t.window_minutes ?? 0,
          },
        })
      }
    }

    if (eventsToSend.length > 0) {
      await step.sendEvent('fire-downstream-events', eventsToSend)
    }

    // ── Step 7: Update feed sync status ─────────────────────────────────────

    await step.run('mark-sync-success', async () => {
      const supabase = createServiceClient()
      await supabase.from('ical_feeds').update({
        last_synced_at:   new Date().toISOString(),
        last_sync_status: 'success',
        last_sync_error:  null,
      }).eq('id', feed_id)

      await supabase.from('org_milestones').upsert(
        { org_id, milestone: 'first_ical_sync' },
        { onConflict: 'org_id,milestone', ignoreDuplicates: true }
      )
    })

    return {
      feed_id,
      newBookings:   newBookings.length,
      newTurnovers:  newTurnoverIds.length,
      cancelled:     cancelledBookingIds.length,
    }
  }
)
