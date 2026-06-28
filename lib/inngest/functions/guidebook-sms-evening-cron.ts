import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { distanceMiles } from '@/lib/geocoding'
import { sendSMS, buildEveningNudgeSMS, buildRainAlertSMS, formatOffer } from '@/lib/sms/telnyx'
import type { GuidebookSponsor } from '@/types/database'

// Known tech debt: properties.timezone does not exist in the live schema.
// Local hour-of-day is computed against America/New_York as a fixed
// approximation for all properties until a timezone cache column returns.
const FALLBACK_TIMEZONE = 'America/New_York'

export const guidebookSmsEveningCron = inngest.createFunction(
  { id: 'guidebook-sms-evening-cron', name: 'Guidebook: Evening SMS Nudge Cron' },
  { cron: '0 22 * * *' }, // ~6pm America/New_York (fixed approximation, see FALLBACK_TIMEZONE)
  async ({ step }) => {
    const hourOfDay = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: FALLBACK_TIMEZONE })
        .format(new Date())
    )

    if (hourOfDay < 17 || hourOfDay >= 21) return { skipped: 'outside evening window' }

    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE }).format(new Date())

    const supabase = createServiceClient()

    const optins = await step.run('fetch-active-optins', async () => {
      const { data, error } = await supabase
        .from('guidebook_guest_sms_optins')
        .select('id, org_id, property_id, phone_e164, last_evening_sms_date')
        .eq('is_active', true)
        .or(`last_evening_sms_date.is.null,last_evening_sms_date.lt.${todayDate}`)

      if (error) throw new Error(`Failed to fetch optins: ${error.message}`)
      return data ?? []
    })

    let sentCount = 0

    for (const optin of optins) {
      await step.run(`send-evening-sms-${optin.id}`, async () => {
        const { data: property } = await supabase
          .from('properties')
          .select('id, name, lat, lng')
          .eq('id', optin.property_id)
          .single()

        if (!property?.lat || !property?.lng) return

        const weather = await getWeatherForLocation(property.lat, property.lng).catch(() => null)

        const { data: sponsors } = await supabase
          .from('guidebook_sponsors')
          .select('*')
          .eq('org_id', optin.org_id)
          .eq('status', 'active')
          .in('slot_type', ['dinner_pints', 'rainy_day'])

        const isRainy        = Boolean(weather?.isRainy || weather?.isSnowy)
        const relevantSlot    = isRainy ? 'rainy_day' : 'dinner_pints'
        const relevantSponsors = (sponsors ?? []).filter((s) => s.slot_type === relevantSlot)
        const nearestSponsor   = pickNearestSponsor(relevantSponsors, property.lat, property.lng)
        const offerLine = nearestSponsor
          ? formatOffer(nearestSponsor.offer_type, nearestSponsor.offer_value, nearestSponsor.offer_item, nearestSponsor.custom_offer_text)
          : null

        const message = isRainy
          ? buildRainAlertSMS(property.name)
          : buildEveningNudgeSMS(property.name, offerLine)

        const result = await sendSMS(optin.phone_e164, message)

        if (result.sent) {
          await supabase
            .from('guidebook_guest_sms_optins')
            .update({ last_evening_sms_date: todayDate, updated_at: new Date().toISOString() })
            .eq('id', optin.id)
          sentCount += 1
        }
      })
    }

    return { sent: sentCount, candidates: optins.length }
  }
)

function pickNearestSponsor(
  sponsors: GuidebookSponsor[],
  lat: number,
  lng: number
): GuidebookSponsor | null {
  let nearest: GuidebookSponsor | null = null
  let nearestDistance = Infinity

  for (const sponsor of sponsors) {
    if (sponsor.lat == null || sponsor.lng == null) continue
    const dist = distanceMiles(lat, lng, sponsor.lat, sponsor.lng)
    if (dist < nearestDistance) {
      nearestDistance = dist
      nearest = sponsor
    }
  }

  return nearest
}
