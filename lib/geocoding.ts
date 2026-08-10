import { GEOCODE_TIMEOUT_MS, isTimeoutError } from '@/lib/http/timeout'
import { fetchWithRetry } from '@/lib/http/retry'
import { reportError } from '@/lib/observability/report-error'

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversineKm(lat1, lng1, lat2, lng2) * 0.621371
}

/**
 * Resolves a US ZIP to coordinates via Mapbox. Returns null for every
 * failure mode — no token, a non-2xx response, a network error, or the
 * request exceeding GEOCODE_TIMEOUT_MS — and never throws.
 *
 * Not-throwing is load-bearing, not incidental: every caller
 * (createProperty/updateProperty, the crew and vendor settings actions, the
 * geocoding-backfill cron) treats null as "save the record without
 * coordinates". A thrown error here would abort a user's property save over
 * a third-party outage, and the bounded timeout is what stops a hung Mapbox
 * from holding that save open until the Vercel function timeout fires.
 */
export async function geocodeZip(
  zip: string
): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.MAPBOX_PUBLIC_TOKEN
  if (!token) return null
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(zip)}.json?country=US&types=postcode&limit=1&access_token=${token}`

  try {
    // Retried: a GET with no side effects, so a duplicate costs nothing but a
    // request. Two attempts rather than the default three — this runs inside
    // createProperty/updateProperty, where the PM is waiting on the save, and
    // the whole point of the timeout budget is that they are not left holding
    // it. Failing to geocode is already a soft failure (returns null; the
    // property saves without coordinates), so spending more of the PM's time
    // to avoid it is the wrong trade.
    const res = await fetchWithRetry(url, {}, {
      attempts:  2,
      timeoutMs: GEOCODE_TIMEOUT_MS,
      label:     'mapbox-geocode',
    })
    if (!res.ok) {
      console.warn('[geocodeZip] Mapbox returned a non-OK response', { zip, status: res.status })
      return null
    }
    const data = await res.json()
    const [lng, lat] = data.features?.[0]?.center ?? []
    return (lat && lng) ? { lat, lng } : null
  } catch (err) {
    // Timeouts are called out separately from real failures: "Mapbox is
    // slow" and "Mapbox rejected us" need different follow-up, and a
    // timeout silently indistinguishable from a 4xx is how a degraded
    // dependency stays invisible.
    if (isTimeoutError(err)) {
      console.warn('[geocodeZip] Mapbox request timed out', { zip, timeoutMs: GEOCODE_TIMEOUT_MS })
    } else {
      console.error('[geocodeZip] Mapbox request failed', {
        zip,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    reportError(err, { site: 'lib.geocoding.geocodeZip', extra: { timedOut: isTimeoutError(err) } })
    return null
  }
}
