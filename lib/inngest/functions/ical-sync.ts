import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { parseIcalFeed, toDateString, toTimeString, isAllDay, type ParsedBooking } from '@/lib/ical/parser'
import { cancelTurnoversForBooking } from '@/lib/turnovers/generator'
import { detectAndFlagOverlaps } from '@/lib/ical/conflict-detection'
import { getPmEmail } from '@/lib/inngest/helpers'
import { resend, FROM } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import type { BookingSource } from '@/types/database'

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
  async ({ event, step, logger }) => {
    const orgId = 'org_id' in event.data ? event.data.org_id : undefined

    const feeds = await step.run('fetch-active-feeds', async () => {
      const supabase = createServiceClient()
      let query = supabase
        .from('ical_feeds')
        .select('id, property_id, org_id')
        .eq('is_active', true)

      if (orgId) query = query.eq('org_id', orgId)

      const { data, error } = await query
      if (error) throw new Error(`Failed to fetch feeds: ${error.message}`)
      return data ?? []
    })

    logger.info(`Syncing ${feeds.length} iCal feeds${orgId ? ` for org ${orgId}` : ' (all orgs)'}`)

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

    const { url: feedUrl, source: feedSource } = await step.run('fetch-feed-url', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('ical_feeds')
        .select('url, source, org_id')
        .eq('id', feed_id)
        .single()

      if (error || !data) throw new Error(`Feed not found: ${feed_id}`)
      if (data.org_id !== org_id) throw new Error(`Feed ${feed_id} org mismatch — expected ${org_id}, got ${data.org_id}`)
      return { url: data.url, source: data.source }
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

        type ExistingRow = { id: string; ical_uid: string; status: string; guest_email: string | null }

        const { data: existingBookings } = await supabase
          .from('bookings')
          .select('id, ical_uid, status, guest_email')
          .eq('ical_feed_id', feed_id)

        const existingByUid = new Map<string, ExistingRow>(
          (existingBookings as ExistingRow[] ?? []).map((b) => [b.ical_uid, b])
        )
        // Inngest serializes step.run() results as JSON, so Date objects become
        // strings. toDateString/toTimeString/isAllDay all accept Date | string.
        type ParsedBookingJson = {
          uid:       string
          guestName: string | null
          start:     string | Date
          end:       string | Date
          status:    ParsedBooking['status']
        }
        const typedEvents = parsedEvents as unknown as ParsedBookingJson[]
        const seenUids = new Set<string>(typedEvents.map((e) => e.uid))

        // ── Bulk upsert all current feed events ──────────────────────────────
        // Single round-trip replaces N individual updates/inserts.
        const upsertRows = typedEvents.map((event) => ({
          property_id:   property_id,
          org_id:        org_id,
          ical_feed_id:  feed_id,
          ical_uid:      event.uid,
          guest_name:    event.guestName,
          guest_email:   null as null,
          checkin_date:  toDateString(event.start),
          checkout_date: toDateString(event.end),
          checkin_time:  isAllDay(event.start) ? null : toTimeString(event.start),
          checkout_time: isAllDay(event.end)   ? null : toTimeString(event.end),
          source:        (feedSource ?? 'other') as BookingSource,
          status:        (event.status === 'cancelled' ? 'cancelled' :
                          event.status === 'blocked'   ? 'blocked'   :
                          event.status === 'tentative' ? 'tentative' : 'confirmed'),
          raw_ical_data: { summary: event.guestName, uid: event.uid },
        }))

        type UpsertedRow = { id: string; ical_uid: string; status: string }
        const { data: upserted } = await supabase
          .from('bookings')
          .upsert(upsertRows, { onConflict: 'ical_feed_id,ical_uid', ignoreDuplicates: false })
          .select('id, ical_uid, status')

        const upsertedRows = upserted as UpsertedRow[] ?? []

        const newBookingRows: Array<{ id: string; guestEmail: string | null }> = []
        const cancelledIds: string[] = []

        for (const row of upsertedRows) {
          // New confirmed booking — uid wasn't in the pre-existing map
          if (!existingByUid.has(row.ical_uid) && row.status === 'confirmed') {
            newBookingRows.push({ id: row.id, guestEmail: null })
          }
          // Booking transitioned to cancelled in this sync
          const prior = existingByUid.get(row.ical_uid)
          if (prior && row.status === 'cancelled' && prior.status !== 'cancelled') {
            cancelledIds.push(row.id)
          }
        }

        // ── Bulk cancel bookings absent from the latest feed ─────────────────
        const toCancel: string[] = []
        for (const [uid, existing] of existingByUid.entries()) {
          if (!seenUids.has(uid) && existing.status === 'confirmed') {
            toCancel.push(existing.id)
            cancelledIds.push(existing.id)
          }
        }

        if (toCancel.length > 0) {
          await supabase
            .from('bookings')
            .update({ status: 'cancelled' })
            .in('id', toCancel)
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

    // ── Step 4b: Detect booking overlaps for this property ──────────────────

    const newConflicts = await step.run('detect-overlap-conflicts', async () => {
      const supabase = createServiceClient()
      return detectAndFlagOverlaps(supabase, property_id)
    })

    if (newConflicts.length > 0) {
      await step.run('alert-pm-overlap-conflict', async () => {
        const supabase = createServiceClient()
        const pmEmail  = await getPmEmail(supabase, org_id)
        if (!pmEmail) return

        const { data: property } = await supabase
          .from('properties').select('name').eq('id', property_id).single()

        await resend.emails.send(
          {
            from:    FROM,
            to:      pmEmail,
            subject: `⚠️ Possible double-booking — ${property?.name ?? 'a property'}`,
            html: await renderPmAlert({
              heading: 'Possible double-booking detected',
              body:    `${newConflicts.length} confirmed booking${newConflicts.length !== 1 ? 's' : ''} at ${property?.name ?? 'this property'} overlap another confirmed booking. Review before guests arrive.`,
              table: {
                headers: ['Source', 'Guest', 'Check-in', 'Check-out'],
                rows: newConflicts.map(c => [
                  c.source,
                  c.guestName ?? '—',
                  c.checkinDate,
                  c.checkoutDate,
                ]),
              },
              ctaLabel: 'Review Bookings →',
              ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/bookings`,
            }),
          },
          // Keyed per property per day — if a new conflict appears later the same
          // day it still sends (different newConflicts content = fine to re-send
          // manually if needed), but retries of the *same* step won't double-send.
          { idempotencyKey: `overlap-conflict-${property_id}-${new Date().toISOString().split('T')[0]}` }
        )
      })
    }

    // ── Step 5: Build and fire downstream events ────────────────────────────
    // Turnovers are generated by handleBookingDetected (one booking/detected
    // event fires per new booking). Generating them here too would call
    // generateTurnoversForProperty N+1 times concurrently for the same property.
    //
    // All DB reads are inside this step.run so replays see consistent data
    // rather than re-querying live DB state on every function resume.

    const eventsToSend = await step.run('build-downstream-events', async () => {
      if (!(newBookings as Array<{ id: string }>).length) return []

      const supabase = createServiceClient()

      type BookingDetectedEvent = {
        name: 'booking/detected'
        data: {
          booking_id: string; property_id: string; org_id: string
          guest_name: string | null; guest_email: string | null
          checkin_date: string; checkout_date: string
        }
      }
      const events: BookingDetectedEvent[] = []

      type BookingDetail = {
        id: string; guest_name: string | null; guest_email: string | null
        checkin_date: string; checkout_date: string
      }

      // Fetch full booking data — filter to confirmed only in case a booking
      // was cancelled between the upsert step and this step
      const { data: bookingDetails, error: detailsError } = await supabase
        .from('bookings')
        .select('id, guest_name, guest_email, checkin_date, checkout_date')
        .in('id', (newBookings as Array<{ id: string }>).map((b) => b.id))
        .eq('status', 'confirmed')

      if (detailsError) throw new Error(`Failed to fetch booking details: ${detailsError.message}`)

      for (const booking of (bookingDetails as BookingDetail[] ?? [])) {
        events.push({
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

      return events
    })

    if (eventsToSend.length > 0) {
      await step.sendEvent('fire-downstream-events', eventsToSend)
    }

    // ── Step 6: Update feed sync status ─────────────────────────────────────

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
      newBookings: newBookings.length,
      cancelled:   cancelledBookingIds.length,
    }
  }
)
