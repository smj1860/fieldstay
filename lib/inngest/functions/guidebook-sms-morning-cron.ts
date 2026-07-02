import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { distanceMiles } from '@/lib/geocoding'
import { sendSMS, buildMorningNudgeSMS, buildRainAlertSMS, formatOffer } from '@/lib/sms/telnyx'
import type { GuidebookSponsor } from '@/types/database'

const FALLBACK_TIMEZONE = 'America/New_York'

export const guidebookSmsMorningCron = inngest.createFunction(
  { id: 'guidebook-sms-morning-cron', name: 'Guidebook: Morning SMS Nudge Cron' },
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
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('guidebook_guest_sms_optins')
        .select(`
          id, org_id, property_id, phone_e164, last_morning_sms_date,
          bookings!inner ( checkin_date, checkout_date )
        `)
        .eq('is_active', true)
        .or(`last_morning_sms_date.is.null,last_morning_sms_date.lt.${todayDate}`)

      if (error) throw new Error(`Failed to fetch optins: ${error.message}`)

      // Filter to guests currently in their stay
      return (data ?? []).filter((o) => {
        const booking = Array.isArray(o.bookings) ? o.bookings[0] : o.bookings
        if (!booking) return false
        return booking.checkin_date <= todayDate && booking.checkout_date >= todayDate
      })
    })

    if (optins.length === 0) return { sent: 0, candidates: 0 }

    // ── Batch fetch properties and sponsors — avoids N+1 ─────────────────────
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
          .in('slot_type', ['morning_brew', 'general'])
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
      const result = await step.run(`send-morning-sms-${optin.id}`, async () => {
        const supabase = createServiceClient()
        const property = propertyMap[optin.property_id]
        if (!property?.lat || !property?.lng) return false

        const weather = await getWeatherForLocation(property.lat, property.lng).catch(() => null)
        if (!weather) return false

        // Rain alert takes priority if precip >= 60% and rainy_day sponsor exists
        if (weather.precipitationProbability >= 60) {
          const { data: rainySponsor } = await supabase
            .from('guidebook_sponsors')
            .select('id, business_name')
            .eq('org_id', optin.org_id)
            .eq('status', 'active')
            .eq('slot_type', 'rainy_day')
            .limit(1)
            .maybeSingle()

          if (rainySponsor) {
            const res = await sendSMS(optin.phone_e164, buildRainAlertSMS(property.name))
            if (res.sent) {
              await supabase
                .from('guidebook_guest_sms_optins')
                .update({ last_morning_sms_date: todayDate, updated_at: new Date().toISOString() })
                .eq('id', optin.id)
            }
            return res.sent
          }
        }

        // Morning brew → general fallback
        const orgSponsors = sponsorsByOrg[optin.org_id] ?? []
        const morningBrews = orgSponsors.filter((s) => s.slot_type === 'morning_brew')
        const pool         = morningBrews.length > 0 ? morningBrews : orgSponsors.filter((s) => s.slot_type === 'general')
        const sponsor      = pickNearestSponsor(pool, property.lat, property.lng)

        if (!sponsor) return false

        const offerLine = formatOffer(
          sponsor.offer_type,
          sponsor.offer_value,
          sponsor.offer_item,
          sponsor.custom_offer_text
        )

        const res = await sendSMS(
          optin.phone_e164,
          buildMorningNudgeSMS(property.name, weather.temperature, offerLine)
        )

        if (res.sent) {
          await supabase
            .from('guidebook_guest_sms_optins')
            .update({ last_morning_sms_date: todayDate, updated_at: new Date().toISOString() })
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
