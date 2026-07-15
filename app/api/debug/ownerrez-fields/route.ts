// TEMPORARY diagnostic route — not part of the product surface.
//
// Purpose: the live `reviews` table shows 0/28 OwnerRez bookings across two
// orgs ever getting a guest_name, including "confirmed" bookings — despite
// getBookings() requesting include_guest=true. That param was never
// confirmed against OwnerRez's real API (unlike the property/address fix
// in 160a3a8, which explicitly cites "confirmed live API shapes") — the
// working theory is it's not a real param at all and OwnerRez silently
// ignores it. This tries several plausible variants for the bookings guest
// data, plus a raw property-list and per-property detail fetch (to check
// the real live shape of address/sqft against properties that do and don't
// currently have those fields populated), all in one hit. Delete this file
// once the real shapes are confirmed and the sync code is fixed to match.
//
// Auth: same as any dashboard page — requireOrgMember, so only a logged-in
// member of the org can hit this. Uses the current user's own OwnerRez
// token directly (same as OwnerRezApiClient), matching the assumption that
// the logged-in PM is the one who connected OwnerRez.
import { NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { readIntegrationToken } from '@/lib/integrations/vault'

const BASE_URL = 'https://api.ownerrez.com'
const PROVIDER = 'ownerrez'

export async function GET() {
  const { user, supabase, membership } = await requireOrgMember()

  const token = await readIntegrationToken(user.id, PROVIDER)
  if (!token) {
    return NextResponse.json({ error: 'No OwnerRez token found for this user.' }, { status: 404 })
  }

  const clientId = process.env.OWNERREZ_CLIENT_ID ?? 'unknown'

  async function orFetch(path: string): Promise<{ url: string; status: number; body: unknown }> {
    const url = `${BASE_URL}${path}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent':  `FieldStay/1.0 (${clientId})`,
        Accept:        'application/json',
      },
    })
    const text = await res.text()
    return { url, status: res.status, body: safeJsonParse(text) }
  }

  const { data: orProperties } = await supabase
    .from('properties')
    .select('id, name, external_id, address, square_footage')
    .eq('org_id', membership.org_id)
    .eq('external_source', PROVIDER)
    .not('external_id', 'is', null)

  // GET /v2/bookings requires property_ids or since_utc (confirmed live —
  // a plain call with neither 400s). Pass both the org's known property
  // ids AND a wide since_utc range so at least one combination succeeds
  // regardless of which one actually works as expected.
  const propertyIdsParam = (orProperties ?? []).map((p) => p.external_id).join(',')
  const sinceUtc = '2020-01-01T00:00:00Z'

  const bookingVariants = await Promise.all([
    orFetch(`/v2/bookings?limit=5&property_ids=${propertyIdsParam}`),
    orFetch(`/v2/bookings?limit=5&property_ids=${propertyIdsParam}&include_guest=true`),
    orFetch(`/v2/bookings?limit=5&property_ids=${propertyIdsParam}&include=guest`),
    orFetch(`/v2/bookings?limit=5&since_utc=${encodeURIComponent(sinceUtc)}&include_guest=true`),
  ])

  // Door codes: per a migration comment, these were meant to come from
  // GET /v2/bookings/{id} (the single-booking DETAIL endpoint) as
  // door_codes[0].code / lock_names — not the list endpoint above. No
  // OwnerRez sync code has ever actually called this. Pull the first
  // booking id off the plain list response and hit its detail endpoint so
  // this diagnostic actually covers it instead of assuming.
  const firstBookingId = extractFirstBookingId(bookingVariants[0].body)
  const bookingDetail = firstBookingId
    ? await orFetch(`/v2/bookings/${firstBookingId}`)
    : { note: 'No booking id found in the list response to fetch detail for.' }

  const propertyList = await orFetch('/v2/properties?limit=5')

  const propertyDetails = orProperties?.length
    ? await Promise.all(
        orProperties.map(async (p) => ({
          fieldstay: { id: p.id, name: p.name, address: p.address, square_footage: p.square_footage },
          live: await orFetch(`/v2/properties/${p.external_id}`),
        }))
      )
    : []

  return NextResponse.json({
    bookingVariants: {
      'property_ids, no guest param':          bookingVariants[0],
      'property_ids + include_guest=true':     bookingVariants[1],
      'property_ids + include=guest':          bookingVariants[2],
      'since_utc + include_guest=true':        bookingVariants[3],
    },
    bookingDetail,
    propertyList,
    propertyDetails,
  })
}

function extractFirstBookingId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object') return null
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items) || !items.length) return null
  const first = items[0] as { id?: string | number }
  return first?.id ?? null
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
