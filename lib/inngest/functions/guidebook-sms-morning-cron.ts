import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { distanceMiles } from '@/lib/geocoding'
import { sendSMS, buildMorningNudgeSMS, formatOffer } from '@/lib/sms/telnyx'
import type { GuidebookSponsor } from '@/types/database'

// Known tech debt: properties.timezone does not exist in the live schema.
// Local hour-of-day is computed against America/New_York as a fixed
// approximation for all properties until a timezone cache column returns.
const FALLBACK_TIMEZONE = 'America/New_York'

export const guidebookSmsMorningCron = inngest.createFunction(
  { id: 'guidebook-sms-morning-cron', name: 'Guidebook: Morning SMS Nudge Cron' },
  { cron: '0 12 * * *' }, // ~8am America/New_York (fixed approximation, see FALLBACK_TIMEZONE)
  async ({ step }) => {
    const hourOfDay = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: FALLBACK_TIMEZONE })
        .format(new Date())
    )

    if (hourOfDay < 7 || hourOfDay >= 11) return { skipped: 'outside morning window' }

    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE }).format(new Date())

    const supabase = createServiceClient()

    const optins = await step.run('fetch-active-optins', async () => {
      const { data, error } = await supabase
        .from('guidebook_guest_sms_optins')
        .select('id, org_id, property_id, phone_e164, last_morning_sms_date')
        .eq('is_active', true)
        .or(`last_morning_sms_date.is.null,last_morning_sms_date.lt.${todayDate}`)

      if (error) throw new Error(`Failed to fetch optins: ${error.message}`)
      return data ?? []
    })

    let sentCount = 0

    for (const optin of optins) {
      await step.run(`send-morning-sms-${optin.id}`, async () => {
        const { data: property } = await supabase
          .from('properties')
          .select('id, name, lat, lng')
          .eq('id', optin.property_id)
          .single()

        if (!property?.lat || !property?.lng) return

        const weather = await getWeatherForLocation(property.lat, property.lng).catch(() => null)
        if (!weather) return

        const { data: sponsors } = await supabase
          .from('guidebook_sponsors')
          .select('*')
          .eq('org_id', optin.org_id)
          .eq('status', 'active')
          .eq('slot_type', 'morning_brew')

        const nearestSponsor = pickNearestSponsor(sponsors ?? [], property.lat, property.lng)
        const offerLine = nearestSponsor
          ? formatOffer(nearestSponsor.offer_type, nearestSponsor.offer_value, nearestSponsor.offer_item, nearestSponsor.custom_offer_text)
          : null

        const result = await sendSMS(
          optin.phone_e164,
          buildMorningNudgeSMS(property.name, weather.temperature, offerLine)
        )

        if (result.sent) {
          await supabase
            .from('guidebook_guest_sms_optins')
            .update({ last_morning_sms_date: todayDate, updated_at: new Date().toISOString() })
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
