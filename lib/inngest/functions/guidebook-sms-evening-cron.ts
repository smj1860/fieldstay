import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { sendSMS, buildSponsorLine } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { claimDailySmsSlot, releaseDailySmsSlot } from '@/lib/sms/optin-claim'
import { pickNearestSponsor } from '@/lib/sms/pick-nearest-sponsor'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { getFeaturedAmenityLine } from '@/lib/guidebook/featured-amenities'
import type { GuidebookSponsor } from '@/types/database'

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
      const { data, error } = await supabase
        .from('guidebook_guest_sms_optins')
        .select(`
          id, org_id, property_id, last_evening_sms_date,
          bookings!inner ( checkin_date, checkout_date )
        `)
        .eq('is_active', true)
        .or(`last_evening_sms_date.is.null,last_evening_sms_date.lt.${todayDate}`)

      if (error) throw new Error(`Failed to fetch optins: ${error.message}`)

      // Filter to guests currently in their stay; exclude checkout day (no dinner nudge)
      return (data ?? [])
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
      const { data: optin } = await supabase
        .from('guidebook_guest_sms_optins')
        .select('id, phone_e164, is_active')
        .eq('id', optinId)
        .maybeSingle()
      if (!optin?.is_active) return false

      const { data: property } = await supabase
        .from('properties')
        .select('id, name, lat, lng, amenities')
        .eq('id', propertyId)
        .maybeSingle()
      if (!property?.lat || !property?.lng) return false

      const weather = await getWeatherForLocation(property.lat, property.lng).catch(() => null)
      const isRainy = Boolean(weather?.isRainy || weather?.isSnowy)

      // Featured-amenity content is independent of sponsors — see
      // guidebook-sms-morning-cron.ts for the full rationale. Offset the
      // rotation by 1 from the morning message so a guest getting both
      // doesn't see the same amenity twice in one day.
      const amenityLine = await getFeaturedAmenityLine(supabase, {
        orgId, propertyId,
        propertyAmenities: property.amenities ?? null,
        checkinDate, todayDate,
        rotationOffset: 1,
      })

      const { data: sponsorsData } = await supabase
        .from('guidebook_sponsors')
        .select('id, org_id, business_name, offer_type, offer_value, offer_item, custom_offer_text, lat, lng, slot_type')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .in('slot_type', ['dinner_pints', 'rainy_day', 'general'])

      const orgSponsors = (sponsorsData ?? []) as GuidebookSponsor[]

      // Rain → dinner → general fallback
      const primarySlot  = isRainy ? 'rainy_day' : 'dinner_pints'
      const primaryPool  = orgSponsors.filter((s) => s.slot_type === primarySlot)
      const generalPool  = orgSponsors.filter((s) => s.slot_type === 'general')
      const pool         = primaryPool.length > 0 ? primaryPool : generalPool
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

      // Claim the slot atomically before sending — a retry of this step
      // after a successful send now finds the slot already claimed and
      // skips re-sending, instead of double-texting the guest.
      const claimed = await claimDailySmsSlot(supabase, optinId, 'last_evening_sms_date', todayDate)
      if (!claimed) return false

      const templateKey = isRainy && primaryPool.length > 0 ? 'rain_alert' as const : 'evening_nudge' as const
      const eveningBody = await renderSmsBody(orgId, templateKey, {
        property_name: property.name,
        offer_line:    offerLine,
      })
      const res = await sendSMS(optin.phone_e164, eveningBody, { category: 'nudge', orgId })

      if (!res.sent) {
        await releaseDailySmsSlot(supabase, optinId, 'last_evening_sms_date')
      }
      return res.sent
    })

    return { optinId, sent }
  }
)
