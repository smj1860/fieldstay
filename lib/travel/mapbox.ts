import 'server-only'

import { MAPBOX_MATRIX_TIMEOUT_MS, isTimeoutError } from '@/lib/http/timeout'
import { fetchWithRetry } from '@/lib/http/retry'
import { reportError } from '@/lib/observability/report-error'
import {
  hasCoordinates, travelLegKey, roundCoord, MILES_PER_KM,
  type TravelStop,
} from '@/lib/travel/estimate'

/**
 * Routed drive times from Mapbox, for the consecutive legs of one day.
 *
 * ── Why the Matrix API and not Directions ──
 * Directions answers one leg per request. A six-stop day is five requests,
 * and an org with twelve crew is sixty — per planner run, every night. The
 * Directions Matrix answers every pair among up to 25 coordinates in ONE
 * request, so a crew member's whole day costs a single call however many
 * stops it holds. We read only the consecutive cells; the rest of the matrix
 * is free and discarded.
 *
 * ── Why no retry beyond two attempts, and why nothing waits on this ──
 * Every failure here is soft. The caller falls back to the straight-line
 * estimate, which is what the plan used before routing existed, so a Mapbox
 * outage degrades the plan's precision and nothing else. That is also why
 * this is called from the overnight planner and never from a page render: a
 * PM clicking Assign must not wait on a third party to find out who is
 * closest.
 */

/** The driving profile's documented ceiling. Not ours to raise. */
const MAX_MATRIX_COORDINATES = 25

export interface RoutedLeg {
  minutes: number
  miles:   number | null
}

interface MatrixResponse {
  code?:      string
  durations?: (number | null)[][]
  distances?: (number | null)[][]
}

/**
 * Chunks a stop list into runs of at most MAX_MATRIX_COORDINATES, overlapping
 * by one.
 *
 * The overlap is the point: consecutive legs span chunk boundaries, so
 * chunking [1..25][26..50] would silently lose the 25→26 leg — the kind of
 * gap that shows up as one mysteriously un-routed leg per 25 stops and
 * nowhere else.
 */
function chunkStops(stops: readonly TravelStop[]): TravelStop[][] {
  if (stops.length <= MAX_MATRIX_COORDINATES) return [[...stops]]

  const chunks: TravelStop[][] = []
  for (let start = 0; start < stops.length - 1; start += MAX_MATRIX_COORDINATES - 1) {
    chunks.push(stops.slice(start, start + MAX_MATRIX_COORDINATES))
  }
  return chunks
}

function matrixUrl(stops: readonly TravelStop[], token: string): string {
  // lng,lat — Mapbox's order, which is the reverse of every other coordinate
  // in this codebase. Rounded to the same precision the cache key uses so a
  // cached row and a fresh request describe the same two points.
  const coords = stops
    .map((s) => `${roundCoord(s.lng!)},${roundCoord(s.lat!)}`)
    .join(';')

  return 'https://api.mapbox.com/directions-matrix/v1/mapbox/driving/'
    + `${coords}?annotations=duration,distance&access_token=${token}`
}

async function fetchMatrix(
  stops: readonly TravelStop[],
  token: string,
): Promise<MatrixResponse | null> {
  try {
    // Two attempts, not the default three: a GET with no side effects is safe
    // to repeat, but the fallback costs nothing and a third try only delays
    // the planner.
    const res = await fetchWithRetry(matrixUrl(stops, token), {}, {
      attempts:  2,
      timeoutMs: MAPBOX_MATRIX_TIMEOUT_MS,
      label:     'mapbox-matrix',
    })

    if (!res.ok) {
      console.warn('[travel.mapbox] Matrix returned a non-OK response', {
        status: res.status, stops: stops.length,
      })
      return null
    }

    const body = await res.json() as MatrixResponse
    if (body.code && body.code !== 'Ok') {
      console.warn('[travel.mapbox] Matrix returned a non-Ok code', { code: body.code })
      return null
    }
    return body
  } catch (err) {
    // A timeout and a rejection need different follow-up, so they are logged
    // apart — same reasoning as lib/geocoding.ts.
    if (isTimeoutError(err)) {
      console.warn('[travel.mapbox] Matrix request timed out', { timeoutMs: MAPBOX_MATRIX_TIMEOUT_MS })
    } else {
      console.error('[travel.mapbox] Matrix request failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    reportError(err, {
      site:  'lib.travel.mapbox.fetchMatrix',
      level: 'warning',   // a degraded plan, not a fault: the caller falls back
      extra: { timedOut: isTimeoutError(err) },
    })
    return null
  }
}

/**
 * Consecutive legs of `stops`, keyed by travelLegKey().
 *
 * Returns an EMPTY map on any failure rather than throwing or partially
 * guessing. Unmappable stops are dropped from the request but keep their
 * position in the chain, so a missing middle coordinate costs its own two
 * legs and not the rest of the day.
 */
export async function routeConsecutiveLegs(
  stops: readonly TravelStop[],
): Promise<Map<string, RoutedLeg>> {
  const out = new Map<string, RoutedLeg>()

  const token = process.env.MAPBOX_PUBLIC_TOKEN
  if (!token) return out

  const routable = stops.filter(hasCoordinates)
  if (routable.length < 2) return out

  for (const chunk of chunkStops(routable)) {
    if (chunk.length < 2) continue
    const body = await fetchMatrix(chunk, token)
    if (!body?.durations) continue

    for (let i = 0; i < chunk.length - 1; i++) {
      const seconds = body.durations[i]?.[i + 1]
      const metres  = body.distances?.[i]?.[i + 1]
      const key     = travelLegKey(chunk[i]!, chunk[i + 1]!)

      // null is Mapbox saying it found no route (an island, a gated road),
      // which is a real answer and NOT a zero-minute drive. Left out so the
      // caller falls back to the straight line and labels it estimated.
      if (key === null || seconds === null || seconds === undefined) continue

      out.set(key, {
        minutes: Math.round(seconds / 60),
        miles:   typeof metres === 'number' ? (metres / 1000) * MILES_PER_KM : null,
      })
    }
  }

  return out
}
