import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { GuestGuidebookView } from '@/components/guidebook/guest-guidebook-view'
import type { GuidebookSponsor, GuidebookPropertyConfig, Property } from '@/types/database'

const FALLBACK_TIMEZONE = 'America/New_York'

const getGuidebookConfig = cache(async (slug: string) => {
  const supabase = createServiceClient({ publicSurface: 'g--slug-' })

  const { data: config } = await supabase
    .from('guidebook_property_configs')
    .select(`
      id, slug, wifi_network, wifi_password, check_in_instructions,
      check_out_instructions, house_rules, is_published, org_id,
      properties(id, name, address, lat, lng, checkin_time, checkout_time)
    `)
    .eq('slug', slug)
    .maybeSingle()

  return config
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const config = await getGuidebookConfig(slug)
  const property = config?.properties as unknown as Property | undefined

  if (!property) {
    return { title: 'Guidebook' }
  }

  return {
    title: `${property.name} — Guidebook`,
    description: `Check-in instructions, wifi, house rules, and local recommendations for ${property.name}.`,
  }
}

export default async function GuestGuidebookPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const supabase = createServiceClient({ publicSurface: 'g--slug-' })

  const config = await getGuidebookConfig(slug)
  if (!config) notFound()

  const property = config.properties as unknown as Property
  if (!property) notFound()

  const { data: orgConfig } = await supabase
    .from('guidebook_configurations')
    .select('is_active')
    .eq('org_id', config.org_id)
    .maybeSingle()

  const isActive = Boolean(config.is_published) && Boolean(orgConfig?.is_active)

  const { data: sponsors } = await supabase
    .from('guidebook_sponsors')
    .select('id, status, slot_type, business_name, business_description, custom_offer_text, address, offer_type, offer_value, offer_item')
    .eq('org_id', config.org_id)
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
    />
  )
}
