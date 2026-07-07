import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { distanceMiles } from '@/lib/geocoding'
import { sendSMS, formatOffer } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import type { GuidebookSponsor } from '@/types/database'

const FALLBACK_TIMEZONE = 'America/New_York'

export const guidebookSmsEveningCron = inngest.createFunction(
  { id: 'guidebook-sms-evening-cron', name: 'Guidebook: Evening SMS Nudge Cron' },
  { cron: '0 22 * * *' },
  async ({ step }) => {
    const hourOfDay = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: FALLBACK_TIMEZONE })
        .format(new Date())
    )
    if (hourOfDay < 17 || hourOfDay >= 21) return { skipped: 'outside evening window' }

    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE }).format(new Date())

    const optins = await step.run('fetch-active-optins', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('guidebook_guest_sms_optins')
        .select(`
          id, org_id, property_id, phone_e164, last_evening_sms_date,
          bookings!inner ( checkin_date, checkout_date )
        `)
        .eq('is_active', true)
        .or(`last_evening_sms_date.is.null,last_evening_sms_date.lt.${todayDate}`)

      if (error) throw new Error(`Failed to fetch optins: ${error.message}`)

      // Filter to guests currently in their stay; exclude checkout day (no dinner nudge)
      return (data ?? []).filter((o) => {
        const booking = Array.isArray(o.bookings) ? o.bookings[0] : o.bookings
        if (!booking) return false
        return booking.checkin_date <= todayDate && booking.checkout_date > todayDate
      })
    })

    if (optins.length === 0) return { sent: 0, candidates: 0 }

    const uniquePropertyIds = [...new Set(optins.map((o) => o.property_id))]
    const uniqueOrgIds      = [...new Set(optins.map((o) => o.org_id))]

    const [propertiesData, sponsorsData] = await Promise.all([
      step.run('batch-fetch-properties', async () => {
        const supabase = createServiceClient()
        const { data } = await supabase
          .from('properties')
          .select('id, name, lat, lng')
          .in('id', uniquePropertyIds)
        return data ?? []
      }),
      step.run('batch-fetch-sponsors', async () => {
        const supabase = createServiceClient()
        const { data } = await supabase
          .from('guidebook_sponsors')
          .select('id, org_id, business_name, offer_type, offer_value, offer_item, custom_offer_text, lat, lng, slot_type')
          .in('org_id', uniqueOrgIds)
          .eq('status', 'active')
          .in('slot_type', ['dinner_pints', 'rainy_day', 'general'])
        return data ?? []
      }),
    ])

    const propertyMap  = Object.fromEntries(propertiesData.map((p) => [p.id, p]))
    const sponsorsByOrg: Record<string, GuidebookSponsor[]> = {}
    for (const s of sponsorsData) {
      if (!sponsorsByOrg[s.org_id]) sponsorsByOrg[s.org_id] = []
      sponsorsByOrg[s.org_id].push(s as GuidebookSponsor)
    }

    let sentCount = 0

    for (const optin of optins) {
      const result = await step.run(`send-evening-sms-${optin.id}`, async () => {
        const supabase = createServiceClient()
        const property = propertyMap[optin.property_id]
        if (!property?.lat || !property?.lng) return false

        const weather = await getWeatherForLocation(property.lat, property.lng).catch(() => null)
        const isRainy = Boolean(weather?.isRainy || weather?.isSnowy)

        const orgSponsors  = sponsorsByOrg[optin.org_id] ?? []

        // Rain → dinner → general fallback
        const primarySlot  = isRainy ? 'rainy_day' : 'dinner_pints'
        const primaryPool  = orgSponsors.filter((s) => s.slot_type === primarySlot)
        const generalPool  = orgSponsors.filter((s) => s.slot_type === 'general')
        const pool         = primaryPool.length > 0 ? primaryPool : generalPool
        const sponsor      = pickNearestSponsor(pool, property.lat, property.lng)

        if (!sponsor) return false

        const offerLine = formatOffer(
          sponsor.offer_type,
          sponsor.offer_value,
          sponsor.offer_item,
          sponsor.custom_offer_text
        )
        const templateKey = isRainy && primaryPool.length > 0 ? 'rain_alert' as const : 'evening_nudge' as const
        const eveningBody = await renderSmsBody(optin.org_id, templateKey, {
          property_name: property.name,
          offer_line:    offerLine ?? '',
        })
        const res = await sendSMS(optin.phone_e164, eveningBody)

        if (res.sent) {
          await supabase
            .from('guidebook_guest_sms_optins')
            .update({ last_evening_sms_date: todayDate, updated_at: new Date().toISOString() })
            .eq('id', optin.id)
        }
        return res.sent
      })

      if (result) sentCount += 1
    }

    return { sent: sentCount, candidates: optins.length }
  }
)

function pickNearestSponsor(
  sponsors: GuidebookSponsor[],
  lat: number,
  lng: number
): GuidebookSponsor | null {
  const withCoords = sponsors.filter((s) => s.lat !== null && s.lng !== null)
  if (withCoords.length === 0) return sponsors[0] ?? null

  let nearest: GuidebookSponsor | null = null
  let nearestDist = Infinity
  for (const s of withCoords) {
    const dist = distanceMiles(lat, lng, s.lat!, s.lng!)
    if (dist < nearestDist) { nearestDist = dist; nearest = s }
  }
  return nearest
}
