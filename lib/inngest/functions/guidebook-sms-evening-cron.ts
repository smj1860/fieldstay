import { asBooleanMap } from '@/lib/json'
import { inngest } from '@/lib/inngest/client'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { sendSMS, buildSponsorLine } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { sendClaimedDailySms } from '@/lib/sms/optin-claim'
import { pickNearestSponsor, SPONSOR_POOL_COLUMNS, type SponsorPoolRow } from '@/lib/sms/pick-nearest-sponsor'
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
        .select('id, name, lat, lng, amenities')
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

      // Bound and error-handled for the same reasons as the morning send's
      // pool: discarding the error made a failed lookup indistinguishable
      // from an org with no sponsors, and both end at "no offer" -> no SMS.
      // fetchAllRows, not a bare select. guidebook_sponsors is capped at SIX
      // rows per org by the schema itself (slot_number CHECK 1..6 plus
      // UNIQUE(org_id, slot_number)), so this drains in exactly one request —
      // the pagination costs nothing at current scale and stops the read from
      // resting on that cap. If the slot ceiling is ever raised, a .limit()
      // would have started truncating silently; this throws instead.
      const orgSponsors = await fetchAllRows<SponsorPoolRow>(
        (from, to) => supabase
          .from('guidebook_sponsors')
          .select(SPONSOR_POOL_COLUMNS)
          .eq('org_id', orgId)
          .eq('status', 'active')
          .in('slot_type', ['dinner_pints', 'rainy_day', 'general'])
          .order('id')
          .range(from, to),
        { label: 'guidebook-sms-evening-send.sponsors' },
      )

      // Rain → dinner → general fallback
      const primarySlot  = isRainy ? 'rainy_day' : 'dinner_pints'
      const primaryPool  = orgSponsors.filter((s) => s.slot_type === primarySlot)
      const generalPool  = orgSponsors.filter((s) => s.slot_type === 'general')
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
          const templateKey = isRainy && primaryPool.length > 0 ? 'rain_alert' as const : 'evening_nudge' as const
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
