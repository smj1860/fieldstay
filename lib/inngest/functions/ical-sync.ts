import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { parseIcalFeed, toDateString, toTimeString, isAllDay, type ParsedBooking } from '@/lib/ical/parser'
import { cancelTurnoversForBooking, notifyCrewOfCancelledTurnovers, type CancelledTurnoverAssignment } from '@/lib/turnovers/generator'
import { detectAndFlagOverlaps } from '@/lib/ical/conflict-detection'
import { getPmEmails } from '@/lib/inngest/helpers'
import { resend, FROM } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import type { BookingSource, TablesInsert, Enums } from '@/types/database'

import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import { safeFetch } from '@/lib/security/url-guard'
import { unwrap, unwrapList, throwIfAnyQueryFailed, isRealQueryError, reportQueryError } from '@/lib/supabase/unwrap'

// Feed fetches are spread across this window to avoid a thundering herd at the
// top of the hour. Applied per-org now that fan-out is two-stage.
const JITTER_WINDOW_MS = 55 * 60 * 1000

// ical_uid is NULLABLE on bookings (rows from OwnerRez/Hospitable have none);
// only feed-sourced rows carry one, and only those can be matched against a
// feed's events.
type ExistingBookingRow = {
  id:            string
  ical_uid:      string | null
  status:        Enums<'booking_status'>
  guest_email:   string | null
  checkout_date: string
}

/**
 * The absent-booking cancellation pass: which known bookings does this feed no
 * longer mention, and of those, which may actually be cancelled?
 *
 * Absence is the ONLY cancellation signal an iCal feed gives — there is no
 * tombstone — so this pass has to exist. Two things bound it.
 *
 * 1. An empty parse is not a mass cancellation.
 *
 * A structurally valid VCALENDAR carrying zero VEVENTs parses cleanly to [].
 * (A non-iCal body does NOT reach here — ICAL.parse throws and the download
 * step fails the run.) With `seenUids` empty, every confirmed booking on the
 * feed is absent, so this pass cancelled all of them,
 * cancelTurnoversForBooking cancelled their pending/assigned turnovers, and
 * notifyCrewOfCancelledTurnovers texted the crew that their jobs were off. The
 * next hourly sync would re-create the bookings, but the turnovers were
 * already cancelled and the crew already told.
 *
 * A host regenerating the feed URL, unpublishing a listing, or serving a
 * placeholder calendar all produce exactly this shape. A genuinely emptied
 * calendar produces it too — the two are indistinguishable from the payload,
 * which is the point: when the signal cannot tell them apart, the tie has to
 * break toward NOT cancelling. Being wrong the other way sends crew home from
 * a stay that is still happening.
 *
 * 2. A booking that aged out of the feed window was not cancelled.
 *
 * Airbnb/VRBO feeds carry a rolling FUTURE window, so a completed stay drops
 * out on its own. Cancelling on absence therefore reclassified finished stays
 * as cancelled once they aged out — wrong in owner_transactions and the owner
 * portal's P&L, for every past booking, forever. Only bookings that have not
 * yet checked out can be meaningfully cancelled by a feed.
 */
function bookingsAbsentFromFeed(params: {
  existingByUid: Map<string, ExistingBookingRow>
  seenUids:      Set<string>
  eventCount:    number
  feedId:        string
  orgId:         string
}): string[] {
  const { existingByUid, seenUids, eventCount, feedId, orgId } = params

  if (eventCount === 0 && existingByUid.size > 0) {
    console.error(
      `[ical-sync] Feed ${feedId} parsed to ZERO events while holding ` +
      `${existingByUid.size} known booking(s) — skipping the absent-booking ` +
      `cancellation pass rather than cancelling them all`
    )
    reportError(new Error('iCal feed parsed empty while holding known bookings'), {
      site:  'inngest.ical-sync.empty-feed-guard',
      orgId,
      extra: { feed_id: feedId, known_bookings: existingByUid.size },
    })
    return []
  }

  const today = new Date().toISOString().slice(0, 10)
  const absent: string[] = []

  for (const [uid, existing] of existingByUid.entries()) {
    if (seenUids.has(uid)) continue
    if (existing.status !== 'confirmed') continue
    if (existing.checkout_date < today) continue   // aged out, not cancelled
    absent.push(existing.id)
  }

  return absent
}

/**
 * SCHEDULED: runs hourly.
 * Also triggered manually via `ical/sync.all.requested`.
 *
 * DISPATCHER ONLY. It resolves the set of orgs that have at least one active
 * feed and fans out one `ical/sync.org.requested` per org; syncOrgIcalFeeds
 * below reads that org's own feeds and fans out the per-feed events.
 *
 * The previous shape read every active feed platform-wide in one unbounded
 * `.select()`. PostgREST caps responses at max_rows (1000), with no error and
 * no truncation signal — so at ~150 tenants x 30 properties x 2 feeds (~9,000
 * feeds) only the first 1,000 ever fanned out and every other feed silently
 * stopped receiving booking updates. That breaks at roughly 17 tenants.
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

    const orgIds = await step.run('find-orgs-with-active-feeds', async () => {
      if (orgId) return [orgId]
      const supabase = createServiceClient({ system: 'inngest:ical-sync' })
      return fetchDistinctOrgIds(
        (from, to) => supabase
          .from('ical_feeds')
          .select('org_id')
          .eq('is_active', true)
          .order('org_id', { ascending: true })
          .range(from, to),
        { label: 'ical_feeds.org_id' }
      )
    })

    logger.info(`iCal sync dispatch: ${orgIds.length} org(s)`)

    if (orgIds.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'fan-out-org-syncs',
      orgIds.map((id) => ({
        name: 'ical/sync.org.requested' as const,
        data: { org_id: id },
      }))
    )

    return { dispatched: orgIds.length }
  }
)

/**
 * Per-org iCal fan-out. One invocation = one tenant, so the feed list read
 * here is naturally bounded by that tenant's property count (and paginated
 * anyway), and a single slow/failing tenant retries only itself.
 */
export const syncOrgIcalFeeds = inngest.createFunction(
  {
    id:          'ical-sync-org',
    name:        'Sync iCal Feeds — per org',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'ical/sync.org.requested' as const },
  async ({ event, step, logger }) => {
    const { org_id } = event.data

    const feeds = await step.run('fetch-active-feeds', async () => {
      const supabase = createServiceClient({ system: 'inngest:ical-sync' })
      return fetchAllRows<{ id: string; property_id: string; org_id: string }>(
        (from, to) => supabase
          .from('ical_feeds')
          .select('id, property_id, org_id')
          .eq('is_active', true)
          .eq('org_id', org_id)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `ical_feeds[org=${org_id}]` }
      )
    })

    logger.info(`Syncing ${feeds.length} iCal feeds for org ${org_id}`)

    if (feeds.length === 0) return { synced: 0 }

    await step.sendEvent(
      'fan-out-feed-syncs',
      feeds.map((feed, index) => {
        const baseDelay = feeds.length > 1
          ? Math.floor((index / (feeds.length - 1)) * JITTER_WINDOW_MS)
          : 0
        // eslint-disable-next-line no-restricted-properties -- schedule jitter to spread feed fetches, not id/token generation
        const randomJitter = Math.floor(Math.random() * 30_000) // NOSONAR -- schedule jitter only, not security-sensitive (see eslint-disable justification above)

        return {
          name: 'ical/sync.requested' as const,
          data: {
            feed_id:     feed.id,
            property_id: feed.property_id,
            org_id:      feed.org_id,
          },
          ts: Date.now() + baseDelay + randomJitter,
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
    // Up to 20 feeds syncing in parallel. The comment used to say 20 while the
    // value said 5 — both were written in the same commit, so this was an
    // original typo rather than a deliberate throttle someone lowered.
    //
    // 5 is not merely conservative, it is under-provisioned: a feed sync takes
    // ~3–8s (external fetch + parse + upsert), so 5 concurrent caps throughput
    // near 3,600 feeds/hour. Demand is 2 feeds x ~30 properties x tenants, so
    // the hourly cron starts queueing faster than it drains at roughly 60
    // tenants — and it fails silently, as calendars going progressively
    // staler while every run still reports success.
    //
    // Raised only now that lib/ical/conflict-detection.ts bounds its overlap
    // scan to current-and-future bookings. Before that, each sync re-read the
    // property's entire booking history and compared every pair, so a 4x
    // concurrency increase would have multiplied the heaviest query in the
    // loop rather than the cheapest.
    concurrency: { limit: 20 },
    // Retry up to 2 times on network errors
    retries: 2,
  },
  { event: 'ical/sync.requested' as const },
  async ({ event, step, logger }) => {
    const { feed_id, property_id, org_id } = event.data

    // ── Step 1: Fetch feed URL and raw data ─────────────────────────────────

    const { url: feedUrl, source: feedSource } = await step.run('fetch-feed-url', async () => {
      const supabase = createServiceClient({ system: 'inngest:ical-sync' })
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
        // safeFetch (lib/security/url-guard.ts) validates the URL AND every
        // redirect hop. The previous guard string-matched the hostname once
        // and then called fetch(), which follows redirects by default — so a
        // feed URL on an attacker-controlled HTTPS host passed the check and
        // then 302'd to http://169.254.169.254/latest/meta-data/, whose body
        // this function parses and persists (readable SSRF, not blind).
        const response = await safeFetch(feedUrl, {
          headers: { 'User-Agent': 'FieldStay/1.0 iCal Sync' },
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching iCal feed`)
        }
        return response.text()
      })
    } catch (err) {
      // Mark feed as errored, then re-throw so Inngest's retry mechanism fires.
      const supabase = createServiceClient({ system: 'inngest:ical-sync' })
      const { error: markErrorErr } = await supabase.from('ical_feeds').update({
        last_synced_at:   new Date().toISOString(),
        last_sync_status: 'error',
        last_sync_error:  err instanceof Error ? err.message : 'Unknown error',
      }).eq('id', feed_id)
      if (markErrorErr) {
        console.error('[ical-sync-all] mark-feed-errored', markErrorErr)
        reportError(markErrorErr, { site: 'inngest.ical-sync-all.download-ical.markErrored' })
      }

      logger.error(`Feed ${feed_id} fetch failed: ${err}`)
      reportError(err, { site: 'inngest.ical-sync-all.download-ical' })
      throw err
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
        const supabase = createServiceClient({ system: 'inngest:ical-sync' })

        type ExistingRow = ExistingBookingRow

        // Paginated: a long-lived feed accumulates more than PostgREST's
        // 1000-row cap, and a truncated "existing" map would make every
        // unseen booking look brand new (re-firing booking/detected) while
        // the cancel-absent pass below silently stopped covering older rows.
        const existingBookings = await fetchAllRows<ExistingRow>(
          (from, to) => supabase
            .from('bookings')
            .select('id, ical_uid, status, guest_email, checkout_date')
            .eq('ical_feed_id', feed_id)
            .order('id', { ascending: true })
            .range(from, to),
          { label: `bookings[feed=${feed_id}]` }
        )

        const existingByUid = new Map<string, ExistingRow>(
          existingBookings
            .filter((b): b is ExistingRow & { ical_uid: string } => b.ical_uid !== null)
            .map((b) => [b.ical_uid, b])
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
        const upsertRows: TablesInsert<'bookings'>[] = typedEvents.map((event) => ({
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
          // Reconciles is_block (checked by turnover generation, guidebook
          // emails, owner portal) with status: 'blocked' (what the bookings
          // UI actually renders "Blocked / Unavailable" from) — previously
          // only status was set here, leaving is_block permanently false
          // for every iCal-sourced block.
          is_block:      event.status === 'blocked',
          // raw_ical_data intentionally left unset here — event.guestName and
          // event.uid are already persisted as guest_name/ical_uid above.
          // Duplicating guest-identifying data into a second column would
          // give it a second, easy-to-forget retention surface with no
          // benefit (nothing reads raw_ical_data).
        }))

        type UpsertedRow = { id: string; ical_uid: string; status: Enums<'booking_status'> }
        const upsertRes = await supabase
          .from('bookings')
          .upsert(upsertRows, { onConflict: 'ical_feed_id,ical_uid', ignoreDuplicates: false })
          .select('id, ical_uid, status')
        const upserted = unwrapList(upsertRes, { site: 'inngest.ical-sync-all.upsert-bookings.upsert', orgId: org_id })

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
        // See bookingsAbsentFromFeed for the two guards that bound this pass:
        // an empty parse is not a mass cancellation, and a booking that aged
        // out of the feed's rolling future window was not cancelled.
        const toCancel = bookingsAbsentFromFeed({
          existingByUid,
          seenUids,
          eventCount: typedEvents.length,
          feedId:     feed_id,
          orgId:      org_id,
        })
        cancelledIds.push(...toCancel)

        if (toCancel.length > 0) {
          const { error: cancelError } = await supabase
            .from('bookings')
            .update({ status: 'cancelled' })
            .in('id', toCancel)
            .eq('org_id', org_id)

          // Bound: discarded, a failed cancel still returned these ids as
          // `cancelledBookingIds`, so the steps below cancelled their turnovers
          // and texted the crew about bookings that were still confirmed.
          if (cancelError) {
            throw new Error(`iCal absent-booking cancel failed: ${cancelError.message}`)
          }
        }

        return { newBookings: newBookingRows, cancelledBookingIds: cancelledIds }
      }
    )

    // ── Step 4: Cancel turnovers for any cancelled bookings ─────────────────

    if (cancelledBookingIds.length > 0) {
      const cancelledAssignments = await step.run('cancel-affected-turnovers', async () => {
        const supabase = createServiceClient({ system: 'inngest:ical-sync' })
        const allCancelled: CancelledTurnoverAssignment[] = []
        for (const bookingId of cancelledBookingIds) {
          allCancelled.push(...(await cancelTurnoversForBooking(bookingId, supabase)))
        }
        return allCancelled
      })

      await step.run('notify-crew-cancelled-turnovers', async () => {
        await notifyCrewOfCancelledTurnovers(cancelledAssignments)
      })
    }

    // ── Step 4b: Detect booking overlaps for this property ──────────────────

    const newConflicts = await step.run('detect-overlap-conflicts', async () => {
      const supabase = createServiceClient({ system: 'inngest:ical-sync' })
      return detectAndFlagOverlaps(supabase, property_id)
    })

    if (newConflicts.length > 0) {
      await step.run('alert-pm-overlap-conflict', async () => {
        const supabase = createServiceClient({ system: 'inngest:ical-sync' })
        const [pmEmail] = await getPmEmails(supabase, org_id)
        if (!pmEmail) return

        const { data: property, error: propertyErr } = await supabase
          .from('properties').select('name').eq('id', property_id).single()
        throwIfAnyQueryFailed(
          { site: 'inngest.ical-sync-all.alert-pm-overlap-conflict', orgId: org_id },
          isRealQueryError(propertyErr) ? propertyErr : null,
        )

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
                  // bookings.source is nullable — an em dash rather than an
                  // empty cell in the PM's double-booking alert.
                  c.source ?? '—',
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

      const supabase = createServiceClient({ system: 'inngest:ical-sync' })

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
      const newBookingIds = (newBookings as Array<{ id: string }>).map((b) => b.id)
      const bookingDetails = await fetchAllRows<BookingDetail>(
        (from, to) => supabase
          .from('bookings')
          .select('id, guest_name, guest_email, checkin_date, checkout_date')
          .in('id', newBookingIds)
          .eq('status', 'confirmed')
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'bookings(new-detail)' }
      )

      for (const booking of bookingDetails) {
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
      const supabase = createServiceClient({ system: 'inngest:ical-sync' })
      const markSuccessRes = await supabase.from('ical_feeds').update({
        last_synced_at:   new Date().toISOString(),
        last_sync_status: 'success',
        last_sync_error:  null,
      }).eq('id', feed_id)
      unwrap(markSuccessRes, { site: 'inngest.ical-sync-all.mark-sync-success.feed', orgId: org_id })

      // Non-fatal: this is the last step of an already-successful sync (the
      // booking upsert and downstream events fired in earlier steps). Throwing
      // over a cosmetic milestone flag would mark this step.run — and,
      // eventually, the whole run — as failed/retried for a sync that already
      // did its real job, same reasoning as turnover-events.ts's
      // record-completion-milestones step.
      const milestoneRes = await supabase.from('org_milestones').upsert(
        { org_id, milestone: 'first_ical_sync' },
        { onConflict: 'org_id,milestone', ignoreDuplicates: true }
      )
      reportQueryError(milestoneRes.error, { site: 'inngest.ical-sync-all.mark-sync-success.milestone', orgId: org_id })
    })

    return {
      feed_id,
      newBookings: newBookings.length,
      cancelled:   cancelledBookingIds.length,
    }
  }
)
