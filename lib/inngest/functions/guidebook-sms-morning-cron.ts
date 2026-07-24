import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { sendSMS, buildSponsorLine } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { claimDailySmsSlot, releaseDailySmsSlot } from '@/lib/sms/optin-claim'
import { pickNearestSponsor } from '@/lib/sms/pick-nearest-sponsor'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { GuidebookSponsor } from '@/types/database'

const FALLBACK_TIMEZONE = 'America/New_York'

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
      const { data, error } = await supabase
        .from('guidebook_guest_sms_optins')
        .select(`
          id, org_id, property_id, last_morning_sms_date,
          bookings!inner ( checkin_date, checkout_date )
        `)
        .eq('is_active', true)
        .or(`last_morning_sms_date.is.null,last_morning_sms_date.lt.${todayDate}`)

      if (error) throw new Error(`Failed to fetch optins: ${error.message}`)

      // Filter to guests currently in their stay
      return (data ?? [])
        .filter((o) => {
          const booking = unwrapJoin(o.bookings)
          if (!booking) return false
          return booking.checkin_date <= todayDate && booking.checkout_date >= todayDate
        })
        .map((o) => ({ id: o.id, org_id: o.org_id, property_id: o.property_id }))
    })

    if (optins.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'fan-out-morning-sms',
      optins.map((o) => ({
        name: 'guidebook/sms_morning.requested' as const,
        data: {
          optin_id:    o.id,
          org_id:      o.org_id,
          property_id: o.property_id,
          today_date:  todayDate,
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
    const { optin_id: optinId, org_id: orgId, property_id: propertyId, today_date: todayDate } = event.data

    const sent = await step.run('send-morning-sms', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-sms-morning-cron' })

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
        .select('id, name, lat, lng')
        .eq('id', propertyId)
        .maybeSingle()
      if (!property?.lat || !property?.lng) return false

      const weather = await getWeatherForLocation(property.lat, property.lng).catch(() => null)
      if (!weather) return false

      // Rain alert takes priority if precip >= 60% and rainy_day sponsor exists
      if (weather.precipitationProbability >= 60) {
        const { data: rainySponsors } = await supabase
          .from('guidebook_sponsors')
          .select('id, org_id, business_name, offer_type, offer_value, offer_item, custom_offer_text, lat, lng, slot_type')
          .eq('org_id', orgId)
          .eq('status', 'active')
          .eq('slot_type', 'rainy_day')

        const pickedRainy = pickNearestSponsor((rainySponsors ?? []) as GuidebookSponsor[], property.lat, property.lng)

        if (pickedRainy) {
          const { sponsor: rainySponsor, distanceMiles: rainyDistanceMi } = pickedRainy

          // Claim the slot atomically before sending — a retry of this
          // step after a successful send now finds the slot already
          // claimed and skips re-sending, instead of double-texting.
          const claimed = await claimDailySmsSlot(supabase, optinId, 'last_morning_sms_date', todayDate)
          if (!claimed) return false

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
          const res = await sendSMS(optin.phone_e164, rainBody, { category: 'nudge' })
          if (!res.sent) {
            await releaseDailySmsSlot(supabase, optinId, 'last_morning_sms_date')
          }
          return res.sent
        }
      }

      // Morning brew → general fallback
      const { data: sponsorsData } = await supabase
        .from('guidebook_sponsors')
        .select('id, org_id, business_name, offer_type, offer_value, offer_item, custom_offer_text, lat, lng, slot_type')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .in('slot_type', ['morning_brew', 'general'])

      const orgSponsors  = (sponsorsData ?? []) as GuidebookSponsor[]
      const morningBrews = orgSponsors.filter((s) => s.slot_type === 'morning_brew')
      const pool         = morningBrews.length > 0 ? morningBrews : orgSponsors.filter((s) => s.slot_type === 'general')
      const picked       = pickNearestSponsor(pool, property.lat, property.lng)

      if (!picked) return false
      const { sponsor, distanceMiles: sponsorDistanceMi } = picked

      const offerLine = buildSponsorLine(
        sponsor.business_name,
        sponsor.offer_type,
        sponsor.offer_value,
        sponsor.offer_item,
        sponsor.custom_offer_text,
        sponsorDistanceMi
      )

      // Claim the slot atomically before sending — see rain-alert branch above.
      const claimed = await claimDailySmsSlot(supabase, optinId, 'last_morning_sms_date', todayDate)
      if (!claimed) return false

      const morningBody = await renderSmsBody(orgId, 'morning_nudge', {
        property_name: property.name,
        temperature:   Math.round(weather.temperature),
        offer_line:    offerLine ?? '',
      })
      const res = await sendSMS(optin.phone_e164, morningBody, { category: 'nudge' })

      if (!res.sent) {
        await releaseDailySmsSlot(supabase, optinId, 'last_morning_sms_date')
      }
      return res.sent
    })

    return { optinId, sent }
  }
)
