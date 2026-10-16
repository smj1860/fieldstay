// lib/evidence/geo.ts
//
// Distances for the visit check-in. Feet end to end: the browser reports GPS
// accuracy in meters, lib/evidence/capture.ts converts it once, and from there
// every column, constant, variable and printed string is feet.
//
// Pure and dependency-free, so the crew PWA, the routes and the packet renderer
// can all import it.

export interface LatLng { lat: number; lng: number }

const EARTH_RADIUS_FT = 20_902_231
const FEET_PER_MILE   = 5_280

/** A check-in farther than this from the property pin is flagged off site, unless the property sets its own radius. */
export const GEOFENCE_WARN_FT = 1_640
export const GEOFENCE_MIN_FT  = 150
export const GEOFENCE_MAX_FT  = 16_000

/** A check-in this accurate (or better) may be used to move the property's map pin. */
export const CHECKIN_PIN_MAX_ACCURACY_FT = 100

/** A started turnover older than this asks for a fresh check-in on the next photo. */
export const CHECKIN_STALE_MIN = 180

const toRad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance in feet (haversine). */
export function distanceFeet(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_FT * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** "850 ft" under 1,000 ft, "1.3 mi" above. The one formatter for the packet, the bell, the badge and the custody list. */
export function formatDistance(feet: number): string {
  if (feet < 1_000) return `${Math.round(feet)} ft`
  return `${(feet / FEET_PER_MILE).toFixed(1)} mi`
}

/** Blank means "use the default radius" (null). Otherwise a whole number of feet inside the CHECK on properties.geofence_radius_ft. */
export function parseGeofenceRadius(raw: FormDataEntryValue | null): { value: number | null } | { error: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { value: null }
  const n = Number(text)
  if (!Number.isInteger(n) || n < GEOFENCE_MIN_FT || n > GEOFENCE_MAX_FT) {
    return { error: `Check-in radius must be a whole number of feet from ${GEOFENCE_MIN_FT} to ${GEOFENCE_MAX_FT.toLocaleString('en-US')}` }
  }
  return { value: n }
}
