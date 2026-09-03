import { asBooleanMap } from '@/lib/json'
import { inngest } from '@/lib/inngest/client'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { getWeatherForLocation, getTomorrowForecastForLocation } from '@/lib/weather/tomorrow'
import { sendSMS, buildSponsorLine } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { sendClaimedDailySms } from '@/lib/sms/optin-claim'
import { pickNearestSponsor } from '@/lib/sms/pick-nearest-sponsor'
import { resolveSponsorsForProperty } from '@/lib/guidebook/resolve-property-sponsors'
import { asSponsorAssignmentMode } from '@/lib/properties/defaults'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { getFeaturedAmenityLine } from '@/lib/guidebook/featured-amenities'
import { asOfferType } from '@/lib/guidebook/offer'

const FALLBACK_TIMEZONE = 'America/New_York'

/**
 * Fan-out shape — see guidebook-sms-morning-cron.ts for the full rationale.
 * The cron selects eligible opt-ins and dispatches one event per guest;
 * guidebookSmsEveningSend below does the throttled weather + Telnyx work.
 * Phone numbers deliberately stay out of the event payload.
 */
export const guidebookSmsEveningCron = inngest.createFunction(
  { id: 'guidebook-sms-evening-cron', name: 'Guidebook: Evening SMS Nudge Cron', retries: 2 },
  { cron: '0 22 * * *' },
  async ({ step }) => {
    const hourOfDay = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: FALLBACK_TIMEZONE })
        .format(new Date())
    )
    if (hourOfDay < 17 || hourOfDay >= 21) return { skipped: 'outside evening window' }

    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE }).format(new Date())

    const optins = await step.run('fetch-active-optins', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-sms-evening-cron' })
      // Paginated: platform-wide — every org's active guest opt-ins, so this
      // grows with tenant count. Truncation means the guests sorted past row
      // 1000 silently never receive their evening message, with no error.
      interface OptinRow {
        id:                     string
        org_id:                 string
        property_id:            string
        last_evening_sms_date:  string | null
        bookings:               { checkin_date: string; checkout_date: string }
                                | { checkin_date: string; checkout_date: string }[]
                                | null
      }

      const data = await fetchAllRows<OptinRow>(
        (from, to) => supabase
          .from('guidebook_guest_sms_optins')
          .select(`
            id, org_id, property_id, last_evening_sms_date,
            bookings!inner ( checkin_date, checkout_date )
          `)
          .eq('is_active', true)
          .or(`last_evening_sms_date.is.null,last_evening_sms_date.lt.${todayDate}`)
          .order('id')
          .range(from, to),
        { label: 'guidebook-sms-evening-cron.optins' },
      )

      // Filter to guests currently in their stay; exclude checkout day (no dinner nudge)
      return data
        .map((o) => ({ ...o, booking: unwrapJoin(o.bookings) }))
        .filter((o) => o.booking && o.booking.checkin_date <= todayDate && o.booking.checkout_date > todayDate)
        .map((o) => ({ id: o.id, org_id: o.org_id, property_id: o.property_id, checkin_date: o.booking!.checkin_date }))
    })

    if (optins.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'fan-out-evening-sms',
      optins.map((o) => ({
        name: 'guidebook/sms_evening.requested' as const,
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

/** The evening slot this message is about. */
type EveningSlot = 'rainy_day' | 'outdoor_adventure' | 'dinner_pints'

/** YYYY-MM-DD, one day on. Date-only arithmetic — no timezone is involved. */
export function nextCalendarDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/**
 * Which slot the evening message is about.
 *
 * Rain is checked FIRST and stays authoritative. `isRainy` reflects tonight's
 * ACTUAL conditions; the outdoor branch reflects a forecast for a day that has
 * not happened. Texting someone hiking plans while it is storming outside
 * because tomorrow's number looks good is worse than sending nothing, so a
 * clear forecast never displaces a rain alert.
 *
 * outdoor_adventure is only reachable when the org actually has a sponsor in
 * that slot — until this branch existed, neither cron ever selected the slot at
 * all, so an Outdoor Adventure sponsor was paying $15/mo for a placement that
 * could not be sent. Selecting the slot with an empty pool would just fall
 * through to `general` while suppressing the dinner recommendation, which is a
 * strictly worse message.
 */
export function pickEveningSlot(
  isRainy:               boolean,
  tomorrowIsClear:       boolean,
  hasOutdoorSponsor:     boolean,
): EveningSlot {
  if (isRainy)                              return 'rainy_day'
  if (tomorrowIsClear && hasOutdoorSponsor) return 'outdoor_adventure'
  return 'dinner_pints'
}

/**
 * The template for a chosen slot. A named function rather than a chained
 * ternary — `sonarjs/no-nested-conditional` is the last rule still at `warn`
 * and the lint budget is exact.
 *
 * `hasPrimarySponsor` matters because a slot whose pool is empty falls back to
 * a `general` sponsor, and a general sponsor under "rain expected today" or
 * "tomorrow looks clear" reads as a claim the sponsor never made.
 */
export function pickEveningTemplateKey(
  slot:              EveningSlot,
  hasPrimarySponsor: boolean,
): 'rain_alert' | 'tomorrow_outdoor' | 'evening_nudge' {
  if (!hasPrimarySponsor)               return 'evening_nudge'
  if (slot === 'rainy_day')             return 'rain_alert'
  if (slot === 'outdoor_adventure')     return 'tomorrow_outdoor'
  return 'evening_nudge'
}

/**
 * Per-guest evening nudge send — throttled and budget-capped the same way
 * as guidebookSmsMorningSend.
 */
export const guidebookSmsEveningSend = inngest.createFunction(
  {
    id:          'guidebook-sms-evening-send',
    name:        'Guidebook: Evening SMS Nudge — per guest',
    retries:     2,
    concurrency: { limit: 5 },
    throttle:    { limit: 60, period: '1m' },
  },
  { event: 'guidebook/sms_evening.requested' },
  async ({ event, step }) => {
    const {
      optin_id: optinId, org_id: orgId, property_id: propertyId,
      today_date: todayDate, checkin_date: checkinDate,
    } = event.data

    const sent = await step.run('send-evening-sms', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-sms-evening-cron' })

      // Re-fetch instead of trusting the dispatch-time snapshot: is_active
      // may have flipped (guest texted STOP) since the cron ran.
      // Unwrapped, not destructured — the same pairing as the morning send.
      // `{ data: optin }` collapsed "this guest opted out" and "the consent
      // read failed" into the same null, and both ended at `return false`, so
      // a transient failure silently suppressed the message with nothing
      // logged and no retry. Opting out is final; a failed read must retry.
      const optinRes = await supabase
        .from('guidebook_guest_sms_optins')
        .select('id, phone_e164, is_active')
        .eq('id', optinId)
        .maybeSingle()

      const optin = unwrap(optinRes, {
        site: 'inngest.guidebook-sms-evening-send.optin', orgId,
      })
      if (!optin?.is_active) return false

      const propertyRes = await supabase
        .from('properties')
        .select('id, name, lat, lng, amenities, sponsor_assignment_mode')
        .eq('id', propertyId)
        .eq('org_id', orgId)
        .maybeSingle()

      const property = unwrap(propertyRes, {
        site: 'inngest.guidebook-sms-evening-send.property', orgId,
      })
      if (!property?.lat || !property?.lng) return false

      const weather = await getWeatherForLocation(property.lat, property.lng).catch(() => null)
      const isRainy = Boolean(weather?.isRainy || weather?.isSnowy)

      // Featured-amenity content is independent of sponsors — see
      // guidebook-sms-morning-cron.ts for the full rationale. Offset the
      // rotation by 1 from the morning message so a guest getting both
      // doesn't see the same amenity twice in one day.
      const amenityLine = await getFeaturedAmenityLine(supabase, {
        orgId, propertyId,
        propertyAmenities: asBooleanMap(property.amenities),
        checkinDate, todayDate,
        rotationOffset: 1,
      })

      // THIS PROPERTY's sponsors, not the org's.
      //
      // Until per-property assignment existed this read was `.eq('org_id',
      // orgId)` and every sponsor reached every property's guests. With the
      // assignment table in place that would be worse than no feature: a
      // manager could remove a sponsor from a cabin in the dashboard and that
      // sponsor's offer would still go out by SMS to that cabin's guests,
      // with the UI now asserting something false.
      //
      // The resolver returns the manager's choice for a manual property and
      // the nearest-per-category pick for an automatic one, so an org that has
      // never touched the feature gets exactly today's behaviour.
      //
      // Errors are NOT swallowed here, for the reason the previous
      // fetchAllRows comment gave: a failed sponsor lookup that produced an
      // empty list would be indistinguishable from an org with no sponsors,
      // and both end at "no offer" -> no SMS. The resolver throws.
      const { sponsors: propertySponsors } = await resolveSponsorsForProperty(
        supabase, orgId,
        {
          id:  property.id,
          lat: property.lat,
          lng: property.lng,
          sponsor_assignment_mode: asSponsorAssignmentMode(property.sponsor_assignment_mode),
        },
        'inngest.guidebook-sms-evening-send.sponsors',
      )

      // Tomorrow's forecast, for the outdoor_adventure branch — fetched only
      // when THIS PROPERTY actually carries a sponsor in that slot AND it
      // isn't already raining, the two conditions under which the answer could
      // change the message. Tomorrow.io bills per call and this runs once per
      // guest per night; asking for a forecast nothing can act on spends that
      // quota on every property that never got an outdoor sponsor.
      //
      // Swallowed the same way as the current conditions above: a forecast
      // outage must degrade to a dinner recommendation, never to no SMS at
      // all. A null forecast means tomorrowIsClear is false, which is exactly
      // the pre-forecast behaviour.
      const hasOutdoorSponsor = propertySponsors.some((s) => s.slot_type === 'outdoor_adventure')
      const forecast = (hasOutdoorSponsor && !isRainy)
        ? await getTomorrowForecastForLocation(
            property.lat, property.lng, nextCalendarDate(todayDate),
          ).catch(() => null)
        : null

      // Rain → tomorrow's outdoors → dinner, each falling back to general.
      const primarySlot  = pickEveningSlot(isRainy, Boolean(forecast?.isClear), hasOutdoorSponsor)
      const primaryPool  = propertySponsors.filter((s) => s.slot_type === primarySlot)
      const generalPool  = propertySponsors.filter((s) => s.slot_type === 'general')
      const pool         = primaryPool.length > 0 ? primaryPool : generalPool
      const picked       = pickNearestSponsor(pool, property.lat, property.lng)

      const sponsorLine = picked
        ? buildSponsorLine(
            picked.sponsor.business_name,
            asOfferType(picked.sponsor.offer_type),
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

      // Claim the slot atomically before sending — a retry of this step
      // after a successful send now finds the slot already claimed and
      // skips re-sending, instead of double-texting the guest.
      // Rendering is INSIDE the claimed section: it can throw too, and
      // releasing only around sendSMS left the day's slot claimed for a
      // template failure just the same.
      return await sendClaimedDailySms(
        supabase, optinId, 'last_evening_sms_date', todayDate,
        async () => {
          const templateKey = pickEveningTemplateKey(primarySlot, primaryPool.length > 0)
          const eveningBody = await renderSmsBody(orgId, templateKey, {
            property_name: property.name,
            offer_line:    offerLine,
          })
          return await sendSMS(optin.phone_e164, eveningBody, { category: 'nudge', orgId })
        },
      )
    })

    return { optinId, sent }
  }
)
