import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { GuestGuidebookView } from '@/components/guidebook/guest-guidebook-view'
import type { GuidebookSponsor, GuidebookPropertyConfig, Property } from '@/types/database'

const FALLBACK_TIMEZONE = 'America/New_York'

export default async function GuestGuidebookPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const supabase = createServiceClient()

  const { data: config } = await supabase
    .from('guidebook_property_configs')
    .select(`
      id, slug, wifi_network, wifi_password, check_in_instructions,
      check_out_instructions, house_rules, is_published, org_id,
      properties(id, name, address, lat, lng)
    `)
    .eq('slug', slug)
    .maybeSingle()

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
    .select('id, status, slot_type, business_name, business_description, custom_offer_text, address, offer_type, offer_value, offer_item, photo_storage_path')
    .eq('org_id', config.org_id)
    .eq('status', 'active')

  const sponsorsWithPhotos = (sponsors ?? []).map((s) => ({
    ...s,
    photoUrl: s.photo_storage_path
      ? supabase.storage.from('guidebook-sponsor-photos').getPublicUrl(s.photo_storage_path).data.publicUrl
      : null,
  }))

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
      sponsors={sponsorsWithPhotos as (GuidebookSponsor & { photoUrl: string | null })[]}
      isActive={isActive}
      hourOfDay={hourOfDay}
      weather={weather}
    />
  )
}
