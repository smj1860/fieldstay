/**
 * Travel between two stops: the ONE implementation.
 *
 * Before this module the same straight-line-over-30mph estimate was written
 * out three times — `app/crew/page.tsx`, `app/(dashboard)/ops/ops-snapshot.tsx`
 * and `lib/planning/day-plan.ts` — each with its own copy of the speed
 * constant and its own idea of what a missing coordinate means. Two of the
 * three returned ZERO for the whole chain the moment any single property
 * lacked coordinates, which reads on screen as "no driving today".
 *
 * PURE and client-safe. It imports nothing but haversineKm, so the crew PWA
 * can call it without pulling a server module into the bundle. Routed times
 * (Mapbox) live in lib/travel/mapbox.ts and lib/travel/resolve.ts, which are
 * server-only and layer on top of these types rather than replacing them.
 *
 * ── An unavailable estimate must never read as zero ──
 * Every result here is LABELLED. A chain reports how many of its legs it
 * could measure and how many it could not, so a caller can say "at least 24
 * miles" for a partially-known day instead of either inventing the missing
 * leg or throwing away the legs it does know. That distinction is the whole
 * reason this returns a record rather than a number.
 */

import { haversineKm } from '@/lib/scoring/geo'

/**
 * The straight-line fallback speed, in one place at last.
 *
 * Deliberately low for a road speed: it is standing in for a route, and the
 * straight line it divides is always shorter than the road. Under-estimating
 * the distance and the speed together lands closer than being optimistic
 * about both. Where a real routed duration is available it is used instead
 * and this constant never enters the arithmetic.
 */
export const AVG_DRIVE_SPEED_MPH = 30
export const MILES_PER_KM = 0.621371

/** How a single leg's figure was arrived at. */
export type TravelSource =
  /** A real driving duration from the routing provider. */
  | 'routed'
  /** Straight-line distance over AVG_DRIVE_SPEED_MPH. */
  | 'estimated'
  /** Not measurable: one or both ends have no coordinates. */
  | 'unknown'

export interface TravelPoint {
  lat: number | null
  lng: number | null
}

export interface TravelStop extends TravelPoint {
  /** Stable identity for this stop — a turnover id, a work order id, 'home'. */
  id:     string
  label?: string | null
}

export interface TravelLeg {
  fromId:  string
  toId:    string
  minutes: number
  /** null when the leg is `unknown`, NOT 0 — there is no distance to report. */
  miles:   number | null
  source:  TravelSource
}

/**
 * A measured leg. ONE map type is used by every consumer — the planner, the
 * cascade ranker and the travel-summary surfaces — so a routed figure
 * resolved once can be handed to all three without reshaping it, and none of
 * them can disagree about what a key means.
 */
export interface TravelLegMinutes {
  minutes: number
  /** Absent or null when the provider gave a duration without a distance. */
  miles?:  number | null
}

export type TravelLegMap = ReadonlyMap<string, TravelLegMinutes>

export interface TravelChain {
  legs:        TravelLeg[]
  /** Summed over MEASURED legs only. */
  minutes:     number
  miles:       number
  measured:    number
  unmeasured:  number
  /**
   * 'mixed' is a real state and not a rounding of the others: a day with two
   * routed legs and one unmappable property is neither routed nor unknown,
   * and flattening it to either one is how a partial figure gets presented as
   * a complete one.
   */
  source:      'routed' | 'estimated' | 'mixed' | 'unknown'
}

/** True only for a usable coordinate pair. (0, 0) is null island, not a stop. */
export function hasCoordinates(point: TravelPoint): boolean {
  return point.lat !== null && point.lng !== null
    && !(point.lat === 0 && point.lng === 0)
    && Number.isFinite(point.lat) && Number.isFinite(point.lng)
}

/**
 * Four decimal places, about 11 metres.
 *
 * The cache is keyed on this, not on the raw column value, so two properties
 * on the same street corner share a row and a re-geocode that nudges a
 * coordinate in the seventh decimal does not silently orphan every cached
 * leg that property appears in.
 */
export function roundCoord(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

/**
 * The cache key for one leg. ORDER MATTERS and is preserved: A to B is not B
 * to A once one-way streets, bridges and turn restrictions are involved, and
 * a key that normalised the pair would serve the reverse route's duration
 * back for the forward trip.
 */
export function travelLegKey(from: TravelPoint, to: TravelPoint): string | null {
  if (!hasCoordinates(from) || !hasCoordinates(to)) return null
  return `${roundCoord(from.lat!)},${roundCoord(from.lng!)}>${roundCoord(to.lat!)},${roundCoord(to.lng!)}`
}

/** Straight-line miles, or null when either end is unmappable. */
export function straightLineMiles(from: TravelPoint, to: TravelPoint): number | null {
  if (!hasCoordinates(from) || !hasCoordinates(to)) return null
  return haversineKm(from.lat!, from.lng!, to.lat!, to.lng!) * MILES_PER_KM
}

export function minutesForMiles(miles: number): number {
  return Math.round((miles / AVG_DRIVE_SPEED_MPH) * 60)
}

/** One leg, straight-line. The `unknown` case carries minutes 0 AND says so. */
export function estimateLeg(from: TravelStop, to: TravelStop): TravelLeg {
  const miles = straightLineMiles(from, to)
  if (miles === null) {
    return { fromId: from.id, toId: to.id, minutes: 0, miles: null, source: 'unknown' }
  }
  return { fromId: from.id, toId: to.id, minutes: minutesForMiles(miles), miles, source: 'estimated' }
}

function summarise(legs: TravelLeg[]): TravelChain {
  const measuredLegs = legs.filter((l) => l.source !== 'unknown')
  const sources      = new Set(measuredLegs.map((l) => l.source))

  let source: TravelChain['source']
  if (measuredLegs.length === 0)                        source = 'unknown'
  else if (measuredLegs.length < legs.length)           source = 'mixed'
  else if (sources.size > 1)                            source = 'mixed'
  else                                                  source = sources.has('routed') ? 'routed' : 'estimated'

  return {
    legs,
    minutes:    measuredLegs.reduce((sum, l) => sum + l.minutes, 0),
    miles:      measuredLegs.reduce((sum, l) => sum + (l.miles ?? 0), 0),
    measured:   measuredLegs.length,
    unmeasured: legs.length - measuredLegs.length,
    source,
  }
}

/**
 * The whole day, stop to stop, in the order given.
 *
 * `known` lets a caller supply durations it already has — a cached or freshly
 * routed leg, keyed by travelLegKey() — and every leg it does not cover falls
 * back to the straight line. That is the seam the routed implementation plugs
 * into: no caller has to choose between "routed" and "estimated" up front,
 * and a day where routing covered three legs out of four still reports the
 * three honestly.
 */
export function chainTravel(
  stops: readonly TravelStop[],
  known?: TravelLegMap,
): TravelChain {
  if (stops.length < 2) return summarise([])

  const legs: TravelLeg[] = []

  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i]!
    const to   = stops[i + 1]!
    const key  = travelLegKey(from, to)
    const hit  = key && known ? known.get(key) : undefined

    if (hit) {
      legs.push({
        fromId: from.id, toId: to.id,
        minutes: hit.minutes,
        // ?? null, never ?? the straight line: mixing a routed duration with
        // an estimated distance would produce a pair of figures describing
        // two different journeys.
        miles: hit.miles ?? null,
        source: 'routed',
      })
    } else {
      legs.push(estimateLeg(from, to))
    }
  }

  return summarise(legs)
}
