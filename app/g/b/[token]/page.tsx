import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { GuestGuidebookView } from '@/components/guidebook/guest-guidebook-view'
import type { GuidebookSponsor, GuidebookPropertyConfig, Property } from '@/types/database'

const FALLBACK_TIMEZONE = 'America/New_York'

const getGuidebookData = cache(async (token: string) => {
  const supabase = createServiceClient()

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, org_id, property_id, checkin_date, checkout_date, guidebook_token')
    .eq('guidebook_token', token)
    .maybeSingle()

  if (!booking) return null

  const { data: config } = await supabase
    .from('guidebook_property_configs')
    .select(`
      id, slug, wifi_network, wifi_password, check_in_instructions,
      check_out_instructions, house_rules, is_published, org_id,
      properties(id, name, address, lat, lng, checkin_time, checkout_time)
    `)
    .eq('property_id', booking.property_id)
    .maybeSingle()

  return { booking, config }
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token } = await params
  const data = await getGuidebookData(token)
  const property = data?.config?.properties as unknown as Property | undefined

  if (!property) {
    return { title: 'Guidebook' }
  }

  return {
    title: `${property.name} — Guidebook`,
    description: `Check-in instructions, wifi, house rules, and local recommendations for ${property.name}.`,
  }
}

export default async function GuestBookingGuidebookPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const supabase = createServiceClient()

  const data = await getGuidebookData(token)
  if (!data) notFound()

  const { booking, config } = data
  if (!config) notFound()

  const property = config.properties as unknown as Property
  if (!property) notFound()

  const { data: orgConfig } = await supabase
    .from('guidebook_configurations')
    .select('is_active, extension_contact_method, extension_ownerrez_url')
    .eq('org_id', booking.org_id)
    .maybeSingle()

  const isActive = Boolean(config.is_published) && Boolean(orgConfig?.is_active)

  // Stay-extension ("Gap Night") offer — only surfaces when the cron has
  // created a pending request for this booking.
  const { data: extensionRequest } = await supabase
    .from('stay_extension_requests')
    .select('id, gap_days, discount_pct, next_booking_checkin, status')
    .eq('booking_id', booking.id)
    .eq('status', 'pending')
    .maybeSingle()

  const { data: sponsors } = await supabase
    .from('guidebook_sponsors')
    .select('id, status, slot_type, business_name, business_description, custom_offer_text, address, offer_type, offer_value, offer_item')
    .eq('org_id', booking.org_id)
    .eq('status', 'active')

  const hourOfDay = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: FALLBACK_TIMEZONE })
      .format(new Date())
  )

  const weather = property.lat && property.lng
    ? await getWeatherForLocation(property.lat, property.lng).catch(() => null)
    : null

  return (
    <GuestGuidebookView
      property={property}
      config={config as unknown as GuidebookPropertyConfig}
      sponsors={sponsors as GuidebookSponsor[] ?? []}
      isActive={isActive}
      hourOfDay={hourOfDay}
      weather={weather}
      extensionRequest={extensionRequest ?? null}
      extensionConfig={
        orgConfig
          ? {
              extension_contact_method: orgConfig.extension_contact_method,
              extension_ownerrez_url:   orgConfig.extension_ownerrez_url,
            }
          : null
      }
    />
  )
}
