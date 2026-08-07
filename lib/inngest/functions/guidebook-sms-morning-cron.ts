import { asBooleanMap } from '@/lib/json'
import { inngest } from '@/lib/inngest/client'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap, unwrapList } from '@/lib/supabase/unwrap'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { sendSMS, buildSponsorLine } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { sendClaimedDailySms } from '@/lib/sms/optin-claim'
import { formatTime12h } from '@/lib/utils/time-of-day'
import { pickNearestSponsor } from '@/lib/sms/pick-nearest-sponsor'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { getFeaturedAmenityLine } from '@/lib/guidebook/featured-amenities'
import type { GuidebookSponsor } from '@/types/database'

const FALLBACK_TIMEZONE = 'America/New_York'

/** Nullability matches the live schema: org_id/property_id are NOT NULL on
 *  guidebook_guest_sms_optins, the last-sent date is nullable, and the
 *  `!inner` booking embed still arrives as an array from PostgREST. */
interface MorningOptinRow {
  id:                    string
  org_id:                string
  property_id:           string
  last_morning_sms_date: string | null
  bookings:
    | { checkin_date: string; checkout_date: string }
    | { checkin_date: string; checkout_date: string }[]
    | null
}

/**
 * Fan-out shape (same pattern as ical-sync/daily-wrapup): the cron only
 * selects eligible opt-ins and dispatches one event per guest. The actual
 * weather lookup + Telnyx send happens in guidebookSmsMorningSend below,
 * which carries real throttle/concurrency limits — the previous shape ran
 * one unthrottled Tomorrow.io + Telnyx call per opt-in, serially, inside a
 * single invocation that grew linearly with platform-wide guest count.
 *
 * The event payload deliberately excludes phone_e164 — Inngest persists
 * event payloads, and guest phone numbers don't belong in job logs. The
 * handler refetches the opt-in row and re-checks is_active so a guest who
 * texted STOP between dispatch and send is never messaged.
 */
export const guidebookSmsMorningCron = inngest.createFunction(
  { id: 'guidebook-sms-morning-cron', name: 'Guidebook: Morning SMS Nudge Cron', retries: 2 },
  { cron: '0 12 * * *' },
  async ({ step }) => {
    const hourOfDay = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: FALLBACK_TIMEZONE })
        .format(new Date())
    )
    if (hourOfDay < 7 || hourOfDay >= 11) return { skipped: 'outside morning window' }

    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE }).format(new Date())

    // ── Fetch eligible opt-ins with booking window validation ─────────────────
    const optins = await step.run('fetch-active-optins', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-sms-morning-cron' })
      // Paginated, and this one matters more than it looks. The DB filter is
      // only `is_active = true` plus "not already nudged today" — opt-in rows
      // are never deleted (they are the TCPA consent audit trail), so this
      // set accumulates every guest who ever opted in, across every tenant,
      // forever. The "is this guest currently mid-stay" narrowing happens in
      // JavaScript BELOW the query, so a max_rows truncation does not merely
      // trim the tail: the 1000 rows PostgREST returns can be entirely
      // historical opt-ins, and the cron then dispatches zero nudges while
      // reporting a clean run.
      const data = await fetchAllRows<MorningOptinRow>(
        (from, to) => supabase
          .from('guidebook_guest_sms_optins')
          .select(`
            id, org_id, property_id, last_morning_sms_date,
            bookings!inner ( checkin_date, checkout_date )
          `)
          .eq('is_active', true)
          .or(`last_morning_sms_date.is.null,last_morning_sms_date.lt.${todayDate}`)
          .order('id')
          .range(from, to),
        { label: 'guidebook-sms-morning.active-optins' },
      )

      // Filter to guests currently in their stay
      return data
        .map((o) => ({ ...o, booking: unwrapJoin(o.bookings) }))
        .filter((o) => o.booking && o.booking.checkin_date <= todayDate && o.booking.checkout_date >= todayDate)
        .map((o) => ({ id: o.id, org_id: o.org_id, property_id: o.property_id, checkin_date: o.booking!.checkin_date }))
    })

    if (optins.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'fan-out-morning-sms',
      optins.map((o) => ({
        name: 'guidebook/sms_morning.requested' as const,
        data: {
          optin_id:     o.id,
          org_id:       o.org_id,
          property_id:  o.property_id,
          today_date:   todayDate,
          checkin_date: o.checkin_date,
        },
      }))
    )

    return { dispatched: optins.length }
  }
)

/**
 * Per-guest morning nudge send. throttle shapes the platform-wide Telnyx
 * request rate (10DLC long codes are throughput-limited); concurrency bounds
 * parallel weather/DB work. claimDailySmsSlot remains the double-send guard
 * across retries, and sendSMS's 'nudge' category enforces the daily
 * platform-wide spend budget.
 */
export const guidebookSmsMorningSend = inngest.createFunction(
  {
    id:          'guidebook-sms-morning-send',
    name:        'Guidebook: Morning SMS Nudge — per guest',
    retries:     2,
    concurrency: { limit: 5 },
    throttle:    { limit: 60, period: '1m' },
  },
  { event: 'guidebook/sms_morning.requested' },
  async ({ event, step }) => {
    const {
      optin_id: optinId, org_id: orgId, property_id: propertyId,
      today_date: todayDate, checkin_date: checkinDate,
    } = event.data

    const sent = await step.run('send-morning-sms', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-sms-morning-cron' })

      // Re-fetch instead of trusting the dispatch-time snapshot: is_active
      // may have flipped (guest texted STOP) since the cron ran.
      //
      // Unwrapped, not destructured. `{ data: optin }` collapsed "this guest
      // opted out" and "the consent read failed" into the same null, and both
      // ended at `return false` — so a transient failure silently suppressed
      // the message with nothing logged and no retry. The two outcomes need
      // opposite handling: opted-out is final, a failed read must be retried.
      const optinRes = await supabase
        .from('guidebook_guest_sms_optins')
        .select('id, phone_e164, is_active')
        .eq('id', optinId)
        .maybeSingle()

      const optin = unwrap(optinRes, {
        site: 'inngest.guidebook-sms-morning-send.optin', orgId,
      })
      if (!optin?.is_active) return false

      const propertyRes = await supabase
        .from('properties')
        .select('id, name, lat, lng, amenities, checkin_time')
        .eq('id', propertyId)
        .eq('org_id', orgId)
        .maybeSingle()

      const property = unwrap(propertyRes, {
        site: 'inngest.guidebook-sms-morning-send.property', orgId,
      })
      if (!property) return false

      // ── Check-in day: this guest has not arrived yet ──────────────────────
      //
      // The eligibility filter is `checkin_date <= today AND checkout_date >=
      // today`, so a guest whose stay STARTS today is in the set — but this
      // cron fires 7-11 AM and check-in is typically mid-afternoon. They were
      // getting the full nudge — "it's 72°F at your rental, here's a coffee
      // spot 0.4 mi away" — hours before they had keys, as though they were
      // already in the house.
      //
      // Deliberately BEFORE the lat/lng and weather guards below: an arrival
      // reminder needs neither, and a property without coordinates should
      // still be able to send one.
      //
      // The outgoing guest on a same-day flip is a different case and is left
      // alone: `checkout_date >= today` includes them on checkout morning,
      // when they ARE still in the house and a local recommendation still
      // lands. The evening cron already excludes them (`checkout_date >
      // today`).
      //
      // Same claim slot, so a guest still gets exactly one morning message —
      // this one instead of the nudge, never both.
      if (checkinDate === todayDate) {
        return await sendClaimedDailySms(
          supabase, optinId, 'last_morning_sms_date', todayDate,
          async () => {
            const checkinAt = formatTime12h(property.checkin_time)
            const arrivalBody = await renderSmsBody(orgId, 'arrival_reminder', {
              property_name: property.name,
              // Omitted entirely rather than left blank when the property has
              // no check-in time — 27 of 27 production properties have one,
              // but the column is nullable and OwnerRez-synced properties
              // explicitly write null.
              checkin_line: checkinAt ? `Just a reminder that check-in is at ${checkinAt}.` : '',
            })
            return await sendSMS(optin.phone_e164, arrivalBody, { category: 'nudge', orgId })
          },
        )
      }

      if (!property.lat || !property.lng) return false

      // Featured-amenity content is independent of sponsors — a property
      // with no active sponsors can still get a message if it has featured
      // amenities. See lib/guidebook/featured-amenities.ts.
      const amenityLine = await getFeaturedAmenityLine(supabase, {
        orgId, propertyId,
        propertyAmenities: asBooleanMap(property.amenities),
        checkinDate, todayDate,
      })

      const weather = await getWeatherForLocation(property.lat, property.lng).catch(() => null)
      if (!weather) return false

      // Rain alert takes priority if precip >= 60% and rainy_day sponsor exists
      if (weather.precipitationProbability >= 60) {
        // Unwrapped like every other read here: a failed sponsor lookup
        // produced an empty pool, which falls through to "no offer" and ends
        // at `return false` — a silently skipped nudge that looks identical to
        // an org with no rainy-day sponsor.
        const rainyRes = await supabase
          .from('guidebook_sponsors')
          .select('id, org_id, business_name, offer_type, offer_value, offer_item, custom_offer_text, lat, lng, slot_type')
          .eq('org_id', orgId)
          .eq('status', 'active')
          .eq('slot_type', 'rainy_day')

        const rainySponsors = unwrapList(rainyRes, {
          site: 'inngest.guidebook-sms-morning-send.rainy-sponsors', orgId,
        })

        const pickedRainy = pickNearestSponsor(rainySponsors as GuidebookSponsor[], property.lat, property.lng)

        if (pickedRainy) {
          const { sponsor: rainySponsor, distanceMiles: rainyDistanceMi } = pickedRainy

          // Claim the slot atomically before sending — a retry of this
          // step after a successful send now finds the slot already
          // claimed and skips re-sending, instead of double-texting.
          // Rendering is INSIDE the claimed section: it can throw too, and
          // releasing only around sendSMS left the day's slot claimed for a
          // template failure just the same.
          return await sendClaimedDailySms(
            supabase, optinId, 'last_morning_sms_date', todayDate,
            async () => {
              const rainOfferLine = buildSponsorLine(
                rainySponsor.business_name,
                rainySponsor.offer_type,
                rainySponsor.offer_value,
                rainySponsor.offer_item,
                rainySponsor.custom_offer_text,
                rainyDistanceMi
              )

              const rainBody = await renderSmsBody(orgId, 'rain_alert', {
                property_name: property.name,
                offer_line:    rainOfferLine,
              })
              return await sendSMS(optin.phone_e164, rainBody, { category: 'nudge', orgId })
            },
          )
        }
      }

      // Morning brew → general fallback
      const sponsorsRes = await supabase
        .from('guidebook_sponsors')
        .select('id, org_id, business_name, offer_type, offer_value, offer_item, custom_offer_text, lat, lng, slot_type')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .in('slot_type', ['morning_brew', 'general'])

      // Same reasoning as the rainy-day pool above.
      const orgSponsors = unwrapList(sponsorsRes, {
        site: 'inngest.guidebook-sms-morning-send.sponsors', orgId,
      }) as GuidebookSponsor[]
      const morningBrews = orgSponsors.filter((s) => s.slot_type === 'morning_brew')
      const pool         = morningBrews.length > 0 ? morningBrews : orgSponsors.filter((s) => s.slot_type === 'general')
      const picked       = pickNearestSponsor(pool, property.lat, property.lng)

      const sponsorLine = picked
        ? buildSponsorLine(
            picked.sponsor.business_name,
            picked.sponsor.offer_type,
            picked.sponsor.offer_value,
            picked.sponsor.offer_item,
            picked.sponsor.custom_offer_text,
            picked.distanceMiles
          )
        : null

      // A property with a featured amenity but no active sponsor still has
      // something worth texting about — only bail when there's neither.
      const offerLine = [amenityLine, sponsorLine].filter(Boolean).join(' ') || null
      if (!offerLine) return false

      // Claim the slot atomically before sending — see rain-alert branch above.
      return await sendClaimedDailySms(
        supabase, optinId, 'last_morning_sms_date', todayDate,
        async () => {
          const morningBody = await renderSmsBody(orgId, 'morning_nudge', {
            property_name: property.name,
            temperature:   Math.round(weather.temperature),
            offer_line:    offerLine,
          })
          return await sendSMS(optin.phone_e164, morningBody, { category: 'nudge', orgId })
        },
      )
    })

    return { optinId, sent }
  }
)
