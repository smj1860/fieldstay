import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { GuestGuidebookView } from '@/components/guidebook/guest-guidebook-view'
import { GuidebookUnavailable } from '@/components/guidebook/guidebook-unavailable'
import type { GuidebookSponsorView } from '@/components/guidebook/guest-guidebook-view'
import type { GuidebookPropertyConfig, Property } from '@/types/database'
import { unwrap } from '@/lib/supabase/unwrap'
import { resolveSponsorsForProperty } from '@/lib/guidebook/resolve-property-sponsors'
import { asSponsorAssignmentMode } from '@/lib/properties/defaults'
import { asOfferType } from '@/lib/guidebook/offer'

/** Only for a property with no timezone — see the note in app/g/b/[token]/page.tsx. */
const FALLBACK_TIMEZONE = 'America/New_York'

// A guidebook's active sponsor slots are a small, curated set per org; the
// explicit bound documents that and keeps it out of the unbounded-select class.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

function sponsorPhotoUrl(path: string | null): string | null {
  if (!path || !SUPABASE_URL) return null
  return `${SUPABASE_URL}/storage/v1/object/public/guidebook-sponsor-photos/${path}`
}

function heroPhotoUrl(path: string | null | undefined): string | null {
  if (!path || !SUPABASE_URL) return null
  return `${SUPABASE_URL}/storage/v1/object/public/guidebook-property-photos/${path}`
}

const CONFIG_FIELDS = `
  id, slug, wifi_network, wifi_password, check_in_instructions,
  check_out_instructions, house_rules, is_published, org_id,
  properties(id, name, address, lat, lng, timezone, checkin_time, checkout_time, sponsor_assignment_mode)
`

const getGuidebookConfig = cache(async (slug: string) => {
  const supabase = createServiceClient({ publicSurface: 'g--slug-' })

  const extended = await supabase
    .from('guidebook_property_configs')
    .select(`${CONFIG_FIELDS}, hero_photo_storage_path`)
    .eq('slug', slug)
    .maybeSingle()

  if (!extended.error) return extended.data

  // Migration not yet applied — degrade gracefully rather than 500ing the guest page.
  console.error('[guidebook] hero photo column unavailable, falling back')
  const fallback = await supabase
    .from('guidebook_property_configs')
    .select(CONFIG_FIELDS)
    .eq('slug', slug)
    .maybeSingle()

  return fallback.data ? { ...fallback.data, hero_photo_storage_path: null as string | null } : null
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

  const orgConfigRes = await supabase
    .from('guidebook_configurations')
    .select('is_active')
    .eq('org_id', config.org_id)
    .maybeSingle()

  const orgConfig = unwrap(orgConfigRes, { site: 'page.g.slug', orgId: config.org_id })

  // M1 (isolation): decide this BEFORE constructing any client-component
  // props. The config row holds wifi_password, check_in_instructions and
  // house_rules; passing it to a 'use client' component puts it in the RSC
  // flight payload (readable in page source) regardless of what that
  // component chooses to render. The gate has to be here, on the server.
  const isActive = Boolean(config.is_published) && Boolean(orgConfig?.is_active)
  if (!isActive) return <GuidebookUnavailable />

  // THIS PROPERTY's sponsors, not the org's.
  //
  // This read used to be `.eq('org_id', ...)`, so every sponsor appeared in
  // every property's guidebook. Once a manager can assign sponsors per
  // property, that is the difference between the page telling the truth and
  // the page contradicting the dashboard.
  //
  // An org that has never touched assignment gets the automatic resolution,
  // which is the nearest sponsor per named category — for a 1-4 property org
  // with at most six sponsors that is the same set it saw before, so nothing
  // changes for them.
  const resolution = await resolveSponsorsForProperty(
    supabase,
    config.org_id,
    {
      id:  property.id,
      lat: property.lat,
      lng: property.lng,
      sponsor_assignment_mode: asSponsorAssignmentMode(property.sponsor_assignment_mode),
    },
    'page.g.slug',
  )
  const sponsors = resolution.sponsors

  const hourOfDay = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: property.timezone || FALLBACK_TIMEZONE,
    }).format(new Date())
  )

  const weather = property.lat && property.lng
    ? await getWeatherForLocation(property.lat, property.lng).catch(() => null)
    : null

  const sponsorViews: GuidebookSponsorView[] = sponsors.map((s) => ({
    id:                   s.id,
    slot_type:            s.slot_type,
    business_name:        s.business_name,
    business_description: s.business_description,
    custom_offer_text:    s.custom_offer_text,
    offer_type:           asOfferType(s.offer_type),
    offer_value:          s.offer_value,
    offer_item:           s.offer_item,
    featured_item:        s.featured_item,
    address:              s.address,
    business_phone:       s.business_phone,
    business_website:     s.business_website,
    lat:                  s.lat,
    lng:                  s.lng,
    photoUrl:             sponsorPhotoUrl(s.photo_storage_path),
  }))

  return (
    <GuestGuidebookView
      property={property}
      config={config as unknown as GuidebookPropertyConfig}
      sponsors={sponsorViews}
      hourOfDay={hourOfDay}
      weather={weather}
      heroPhotoUrl={heroPhotoUrl(config.hero_photo_storage_path)}
      stay={null}
      bookingToken={null}
    />
  )
}
