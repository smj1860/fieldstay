import { distanceMiles } from '@/lib/geocoding'

/**
 * The columns the SMS nudge crons actually read off a sponsor, and the SELECT
 * string that fetches exactly them.
 *
 * Shared so the morning and evening pools cannot drift apart, and so the reads
 * can be typed honestly: they select a SUBSET of guidebook_sponsors, and
 * asserting the result is a full GuidebookSponsor was a cast that happened to
 * compile rather than a fact.
 */
export const SPONSOR_POOL_COLUMNS =
  'id, org_id, business_name, offer_type, offer_value, offer_item, custom_offer_text, lat, lng, slot_type'

export interface SponsorPoolRow {
  id:                string
  org_id:            string
  business_name:     string
  offer_type:        string
  offer_value:       number | null
  offer_item:        string | null
  custom_offer_text: string | null
  lat:               number | null
  lng:               number | null
  slot_type:         string
}

/**
 * Picks the sponsor nearest to the given property coordinates. Sponsors
 * without coordinates only win when NO sponsor in the pool has them (first
 * one is used as the fallback). Previously duplicated verbatim in both the
 * morning and evening SMS nudge crons.
 */
// Generic over anything carrying coordinates: the only fields this function
// reads are lat/lng, so constraining callers to a full GuidebookSponsor forced
// every narrow SELECT to cast its way in. The caller keeps its own row type and
// gets it back on `.sponsor`.
export function pickNearestSponsor<T extends { lat: number | null; lng: number | null }>(
  sponsors: T[],
  lat: number,
  lng: number
): { sponsor: T; distanceMiles: number | null } | null {
  const withCoords = sponsors.filter((s) => s.lat !== null && s.lng !== null)
  if (withCoords.length === 0) {
    const fallback = sponsors[0]
    return fallback ? { sponsor: fallback, distanceMiles: null } : null
  }

  let nearest: T | null = null
  let nearestDist = Infinity
  for (const s of withCoords) {
    const dist = distanceMiles(lat, lng, s.lat!, s.lng!)
    if (dist < nearestDist) { nearestDist = dist; nearest = s }
  }
  return nearest ? { sponsor: nearest, distanceMiles: nearestDist } : null
}
