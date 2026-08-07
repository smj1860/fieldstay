import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { GuestGuidebookView, asExtensionContactMethod } from '@/components/guidebook/guest-guidebook-view'
import { GuidebookUnavailable } from '@/components/guidebook/guidebook-unavailable'
import type { GuidebookSponsorView } from '@/components/guidebook/guest-guidebook-view'
import type { GuidebookSponsor, GuidebookPropertyConfig, Property } from '@/types/database'

/**
 * Used only when a property somehow has no timezone. It is NOT the default:
 * computing "what time is it for this guest" in Eastern for every property in
 * the country is how a Central property's guidebook reads midnight at 11pm
 * local — and hourOfDay selects which SPONSOR SLOTS are shown, so the wrong
 * hour shows the wrong paying sponsors. Production is already 4 of 27
 * properties in America/Chicago, and the error grows westward: two hours in
 * Mountain, three in Pacific, five in Hawaii.
 */
const FALLBACK_TIMEZONE = 'America/New_York'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

function sponsorPhotoUrl(path: string | null): string | null {
  if (!path || !SUPABASE_URL) return null
  return `${SUPABASE_URL}/storage/v1/object/public/guidebook-sponsor-photos/${path}`
}

function heroPhotoUrl(path: string | null | undefined): string | null {
  if (!path || !SUPABASE_URL) return null
  return `${SUPABASE_URL}/storage/v1/object/public/guidebook-property-photos/${path}`
}

type StayPhase = 'arrival' | 'mid' | 'checkout'

export function computeStay(checkinDate: string, checkoutDate: string, timeZone: string): {
  phase: StayPhase; nightIndex: number; totalNights: number
} {
  // The guest's local date, not the server's and not Eastern's. On checkout
  // eve a Central property crossed into `checkout` phase an hour early, so the
  // guidebook showed checkout instructions to a guest still mid-stay.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()) // YYYY-MM-DD
  const totalNights = Math.max(1, Math.round(
    (Date.parse(checkoutDate) - Date.parse(checkinDate)) / 86_400_000
  ))
  if (today >= checkoutDate) return { phase: 'checkout', nightIndex: totalNights, totalNights }
  if (today <= checkinDate)  return { phase: 'arrival',  nightIndex: 0, totalNights }
  const nightIndex = Math.min(totalNights - 1, Math.round(
    (Date.parse(today) - Date.parse(checkinDate)) / 86_400_000
  ))
  return { phase: 'mid', nightIndex, totalNights }
}

const CONFIG_FIELDS = `
  id, slug, wifi_network, wifi_password, check_in_instructions,
  check_out_instructions, house_rules, is_published, org_id,
  properties(id, name, address, lat, lng, timezone, checkin_time, checkout_time)
`

const getGuidebookData = cache(async (token: string) => {
  const supabase = createServiceClient({ publicSurface: 'g-b--token-' })

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, org_id, property_id, checkin_date, checkout_date, guidebook_token')
    .eq('guidebook_token', token)
    .maybeSingle()

  if (!booking) return null

  const extended = await supabase
    .from('guidebook_property_configs')
    .select(`${CONFIG_FIELDS}, hero_photo_storage_path`)
    .eq('property_id', booking.property_id)
    .maybeSingle()

  if (!extended.error) return { booking, config: extended.data }

  // Migration not yet applied — degrade gracefully rather than 500ing the guest page.
  console.error('[guidebook] hero photo column unavailable, falling back')
  const fallback = await supabase
    .from('guidebook_property_configs')
    .select(CONFIG_FIELDS)
    .eq('property_id', booking.property_id)
    .maybeSingle()

  const config = fallback.data ? { ...fallback.data, hero_photo_storage_path: null as string | null } : null
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
  const supabase = createServiceClient({ publicSurface: 'g-b--token-' })

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

  // Same server-side gate as app/g/[slug]/page.tsx — see M1 note there. Lower
  // risk here (a booking token is required to reach this route at all) but the
  // leak shape is identical, so the fix is identical.
  const isActive = Boolean(config.is_published) && Boolean(orgConfig?.is_active)
  if (!isActive) return <GuidebookUnavailable />

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
    .select('id, status, slot_type, business_name, business_description, custom_offer_text, address, offer_type, offer_value, offer_item, featured_item, business_phone, business_website, lat, lng, photo_storage_path')
    .eq('org_id', booking.org_id)
    .eq('status', 'active')

  const timeZone = property.timezone || FALLBACK_TIMEZONE

  const hourOfDay = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone })
      .format(new Date())
  )

  const weather = property.lat && property.lng
    ? await getWeatherForLocation(property.lat, property.lng).catch(() => null)
    : null

  const sponsorViews: GuidebookSponsorView[] = ((sponsors ?? []) as GuidebookSponsor[]).map((s) => ({
    id:                   s.id,
    slot_type:            s.slot_type,
    business_name:        s.business_name,
    business_description: s.business_description,
    custom_offer_text:    s.custom_offer_text,
    offer_type:           s.offer_type,
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
      stay={computeStay(booking.checkin_date, booking.checkout_date, timeZone)}
      bookingToken={token}
      extensionRequest={extensionRequest ?? null}
      extensionConfig={
        orgConfig
          ? {
              extension_contact_method: asExtensionContactMethod(orgConfig.extension_contact_method),
              extension_ownerrez_url:   orgConfig.extension_ownerrez_url,
            }
          : null
      }
    />
  )
}
