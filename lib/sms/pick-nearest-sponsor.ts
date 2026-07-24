import { distanceMiles } from '@/lib/geocoding'
import type { GuidebookSponsor } from '@/types/database'

/**
 * Picks the sponsor nearest to the given property coordinates. Sponsors
 * without coordinates only win when NO sponsor in the pool has them (first
 * one is used as the fallback). Previously duplicated verbatim in both the
 * morning and evening SMS nudge crons.
 */
export function pickNearestSponsor(
  sponsors: GuidebookSponsor[],
  lat: number,
  lng: number
): { sponsor: GuidebookSponsor; distanceMiles: number | null } | null {
  const withCoords = sponsors.filter((s) => s.lat !== null && s.lng !== null)
  if (withCoords.length === 0) {
    const fallback = sponsors[0]
    return fallback ? { sponsor: fallback, distanceMiles: null } : null
  }

  let nearest: GuidebookSponsor | null = null
  let nearestDist = Infinity
  for (const s of withCoords) {
    const dist = distanceMiles(lat, lng, s.lat!, s.lng!)
    if (dist < nearestDist) { nearestDist = dist; nearest = s }
  }
  return nearest ? { sponsor: nearest, distanceMiles: nearestDist } : null
}
