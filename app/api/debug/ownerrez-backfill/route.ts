// TEMPORARY one-time backfill route — not part of the product surface.
//
// Purpose: org 15d8610a-a9af-4b6e-950d-8eef0e178239 ("OwnerRez Testing",
// Paul's test account) connected before this session's OwnerRez
// field-mapping fixes (address, sqft, guest_name, actual_total_amount)
// landed. Its properties and bookings were synced with the old broken
// mappers and have no mechanism to self-heal: the daily reconciliation
// cron only detects hard-deleted bookings, and the 15-minute incremental
// cron only fetches bookings changed since the stored sync_cursor — neither
// re-upserts unchanged historical rows. This route re-fetches everything
// for that one connection and re-upserts with the corrected mappers.
//
// Delete this file once it has been run successfully.
//
// Auth: requireOrgMember() only confirms the caller is a signed-in
// FieldStay user — this deliberately operates on a hardcoded target
// org/user regardless of the caller's own org, since fixing another
// tenant's stale sync data is inherently a cross-tenant admin action.
// Matches the (now-deleted) ownerrez-fields diagnostic route precedent:
// temporary, narrowly scoped, deleted right after use.
import { NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient } from '@/lib/integrations/providers/ownerrez-api'
import {
  buildOwnerRezDetailPatch,
  buildOwnerRezBookingRow,
  selectOwnerRezBookingsToPostRevenue,
} from '@/lib/integrations/providers/ownerrez'
import { inngest } from '@/lib/inngest/client'

const TARGET_ORG_ID  = '15d8610a-a9af-4b6e-950d-8eef0e178239'
const TARGET_USER_ID = '1a05ab0a-7bfc-4f49-a0c4-dc195fc12a91'
const PROVIDER = 'ownerrez'

export async function GET() {
  await requireOrgMember() // any signed-in FieldStay user may trigger this temporary tool

  const supabase = createServiceClient()

  const { data: connection } = await supabase
    .from('integration_connections')
    .select('status')
    .eq('org_id', TARGET_ORG_ID)
    .eq('user_id', TARGET_USER_ID)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  if (!connection || connection.status !== 'active') {
    return NextResponse.json(
      { error: `Connection not active (status: ${connection?.status ?? 'not found'})` },
      { status: 400 }
    )
  }

  const client = new OwnerRezApiClient(TARGET_USER_ID)

  // ── Properties: re-fetch + re-upsert ────────────────────────────────────
  const properties = await client.getProperties()

  const propertyRows = properties.map((p) => ({
    org_id:                  TARGET_ORG_ID,
    name:                    p.name,
    bedrooms:                p.bedrooms,
    bathrooms:               p.bathrooms,
    max_guests:              p.max_occupancy,
    external_id:             String(p.id),
    external_source:         PROVIDER,
    property_type:           'other',
    avg_stay_length:         0,
    avg_turnovers_per_month: 0,
    checkout_time:           '11:00',
    checkin_time:            '15:00',
    setup_steps_completed:   {},
    is_active:               true,
  }))

  const { error: propUpsertErr } = await supabase
    .from('properties')
    .upsert(propertyRows, { onConflict: 'org_id,external_id,external_source' })

  if (propUpsertErr) {
    return NextResponse.json({ error: `Property upsert failed: ${propUpsertErr.message}` }, { status: 500 })
  }

  const { data: dbProps } = await supabase
    .from('properties')
    .select('id, external_id, bedrooms, bathrooms, square_footage, wifi_name, wifi_password, access_instructions, house_manual')
    .eq('org_id', TARGET_ORG_ID)
    .eq('external_source', PROVIDER)

  const propsById = new Map((dbProps ?? []).map((p) => [p.external_id as string, p]))

  // ── Patch null sqft — never overwrites a value already set ──────────────
  let sqftPatched = 0
  for (const p of properties) {
    const dbProp = propsById.get(String(p.id))
    if (!dbProp) continue
    const sqft = p.living_area ?? null
    if (sqft !== null && !dbProp.square_footage) {
      await supabase.from('properties').update({ square_footage: sqft }).eq('id', dbProp.id)
      sqftPatched++
    }
  }

  // ── Property detail + listings: fixes missing address/lat-lng/rules ─────
  const listings = await client.getListings({ includeAmenities: true })
  const listingByPropertyId = new Map(listings.map((l) => [String(l.property_id), l]))

  let detailsPatched = 0
  for (const p of properties) {
    const dbProp = propsById.get(String(p.id))
    if (!dbProp) continue

    const detail  = await client.getPropertyDetail(p.id).catch(() => null)
    const listing = listingByPropertyId.get(String(p.id))
    const patch   = buildOwnerRezDetailPatch(dbProp, detail, listing)

    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString()
      await supabase.from('properties').update(patch).eq('id', dbProp.id).eq('org_id', TARGET_ORG_ID)
      detailsPatched++
    }

    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Bookings: full re-fetch + re-upsert ──────────────────────────────────
  const externalToFsId = Object.fromEntries(
    (dbProps ?? []).map((p) => [p.external_id as string, p.id as string])
  )

  const bookings = await client.getBookings({
    propertyIds:  properties.map((p) => p.id),
    includeGuest: true,
  })

  const bookingRows = bookings.map((b) => buildOwnerRezBookingRow(TARGET_ORG_ID, b, externalToFsId))

  const { data: upserted, error: bookingUpsertErr } = await supabase
    .from('bookings')
    .upsert(bookingRows, { onConflict: 'org_id,external_id,external_source' })
    .select('id, external_id')

  if (bookingUpsertErr) {
    return NextResponse.json({ error: `Booking upsert failed: ${bookingUpsertErr.message}` }, { status: 500 })
  }

  const idByExternalId = Object.fromEntries(
    (upserted ?? []).map((row) => [row.external_id, row.id as string])
  )

  const bookingsToPostRevenue = selectOwnerRezBookingsToPostRevenue(bookingRows, idByExternalId)

  for (const b of bookingsToPostRevenue) {
    await inngest.send({
      name: 'booking/confirmed',
      data: {
        booking_id:          b.bookingId,
        property_id:         b.propertyId,
        org_id:              TARGET_ORG_ID,
        source:              'ownerrez',
        actual_total_amount: b.actualTotalAmount,
      },
    })
  }

  return NextResponse.json({
    properties_upserted: propertyRows.length,
    sqft_patched:         sqftPatched,
    details_patched:      detailsPatched,
    bookings_upserted:    bookingRows.length,
    revenue_events_sent:  bookingsToPostRevenue.length,
  })
}
