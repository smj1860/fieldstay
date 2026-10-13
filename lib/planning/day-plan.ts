/**
 * The day planner: turning one crew member's set of turnovers for one date
 * into a sequence of planned start and end times.
 *
 * PURE over its inputs. The caller owns every query, which is what keeps the
 * per-row round trips out of it (see unit/guardrails/n-plus-one-loops) and
 * what makes the hard cases below testable without a database.
 *
 * ── What it is actually solving ──
 * The crew card today shows `checkout_datetime`, which is when the GUEST
 * leaves. A cleaner reads that as "be there at 10am" when it really means
 * "the property is free from 10am". With three jobs in a day, two of those
 * three readings are wrong, and the third is luck.
 *
 * ── The ordering is fixed, not optimised ──
 * Jobs are sequenced by the time the property becomes free, earliest first.
 * This is deliberately NOT a travelling-salesman solve. A route that saves
 * eleven minutes by visiting the far property second is worthless if it puts
 * a cleaner at a door before the guest has gone, and a PM cannot sanity-check
 * an order they did not expect. Earliest-free-first is the order a dispatcher
 * would pick by hand, which is what makes the output reviewable.
 */

import {
  travelLegKey, straightLineMiles, minutesForMiles,
  type TravelPoint, type TravelLegMap,
} from '@/lib/travel/estimate'

/**
 * Minutes assumed between arriving and starting work: parking, unloading,
 * finding the lockbox. Small, but it is the difference between a plan that is
 * tight and one that is impossible, and leaving it at zero quietly asserts
 * that a cleaner teleports from their car to the kitchen.
 */
export const ARRIVAL_BUFFER_MINUTES = 10

export interface PlannableTurnover {
  turnover_id:       string
  /** When the property becomes free. The earliest a crew member can start. */
  checkout_datetime: string
  /**
   * When the next guest arrives, when there IS one. Null on a standalone
   * turnover, which has no hard end and must not be made to look urgent.
   */
  checkin_datetime:  string | null
  lat:               number | null
  lng:               number | null
  /** Estimated minutes of work. The caller supplies this; see estimateMinutes. */
  duration_minutes:  number
}

export interface PlannedSlot {
  turnover_id:      string
  planned_start_at: string
  planned_end_at:   string
  /**
   * True when this job cannot finish before the next guest arrives, even
   * starting the moment the property is free.
   *
   * Surfaced rather than silently clamped: a plan that quietly shows a
   * finish time after check-in looks like every other plan, and the one thing
   * a PM needs from this feature is to see the day that will not work BEFORE
   * it happens.
   */
  infeasible:       boolean
}

export interface DayPlan {
  slots: PlannedSlot[]
  /** Convenience for the caller: any slot that cannot make its check-in. */
  hasInfeasible: boolean
}

const MS_PER_MINUTE = 60_000

/**
 * Minutes from the previous stop to this one.
 *
 * `routed` holds real driving durations keyed by travelLegKey() — the day
 * planner fills it from lib/travel/resolve.ts, which reads Mapbox through a
 * per-pair cache. A leg it does not cover falls back to the straight line,
 * which is what every version of this function did before routing existed.
 * Both paths now go through lib/travel/estimate.ts rather than each carrying
 * their own speed constant.
 *
 * ── Why the commute from home is not added here ──
 * Not for want of the data: it is that the first job's start is NOT
 * constrained by it. A crew member can leave home as early as they like, so
 * the binding constraint on job one is when the guest leaves, full stop.
 * Adding a commute would push the first start later than the property is
 * free, for no reason a PM could defend. The home legs belong in the day's
 * total DRIVE TIME, which is a different question and lives in the travel
 * summary surfaces.
 */
function travelMinutes(
  from:   TravelPoint | null,
  to:     TravelPoint,
  routed?: TravelLegMap,
): number {
  // No previous stop: the first job of the day has nothing to drive from.
  if (!from) return 0

  const key   = travelLegKey(from, to)
  const known = key !== null && routed ? routed.get(key) : undefined
  if (known !== undefined) return known.minutes

  const miles = straightLineMiles(from, to)
  return miles === null ? 0 : minutesForMiles(miles)
}

/**
 * Sequences one crew member's day.
 *
 * Each job starts at the later of: when the property becomes free, and when
 * the crew member can physically get there from the previous one. Those are
 * different constraints and both bind — using only the first produces a plan
 * where someone is in two places at once, and using only the second has them
 * arriving while the guest is still packing.
 */
export interface PlanDayOptions {
  /**
   * Real driving minutes per leg, keyed by travelLegKey(from, to). Partial by
   * design: whatever is missing falls back to the straight-line estimate, so
   * a day where routing covered three legs of four still uses the three.
   */
  routedTravel?: TravelLegMap
}

export function planDay(
  turnovers: readonly PlannableTurnover[],
  options:   PlanDayOptions = {},
): DayPlan {
  const ordered = [...turnovers].sort(
    (a, b) => Date.parse(a.checkout_datetime) - Date.parse(b.checkout_datetime),
  )

  const slots: PlannedSlot[] = []
  let freeFrom: number | null = null
  let previous: { lat: number | null; lng: number | null } | null = null

  for (const t of ordered) {
    const propertyFree = Date.parse(t.checkout_datetime)
    if (Number.isNaN(propertyFree)) continue

    const travel      = travelMinutes(previous, t, options.routedTravel)
    const earliestYou = freeFrom === null
      ? propertyFree
      : freeFrom + (travel + ARRIVAL_BUFFER_MINUTES) * MS_PER_MINUTE

    const start = Math.max(propertyFree, earliestYou)
    const end   = start + t.duration_minutes * MS_PER_MINUTE

    // Measured against the guest's arrival, the same bar `was_late` uses.
    //
    // `null` and an unparseable date are both "no deadline" here but they are
    // not the same thing, so they are not collapsed into one NaN sentinel: a
    // standalone turnover genuinely has no incoming guest, while a malformed
    // checkin_datetime is data we could not read. Neither can be late, and
    // keeping them distinct is what stops a future reader assuming the second
    // case cannot happen.
    const checkin    = t.checkin_datetime === null ? null : Date.parse(t.checkin_datetime)
    const hasDeadline = checkin !== null && !Number.isNaN(checkin)
    const infeasible  = hasDeadline && end > checkin

    slots.push({
      turnover_id:      t.turnover_id,
      planned_start_at: new Date(start).toISOString(),
      planned_end_at:   new Date(end).toISOString(),
      infeasible,
    })

    freeFrom = end
    previous = { lat: t.lat, lng: t.lng }
  }

  return { slots, hasInfeasible: slots.some((s) => s.infeasible) }
}

/**
 * Minutes of work for one turnover.
 *
 * `avg_minutes_per_bedroom` comes from crew_speed_baselines, the rolling
 * 90-day figure the friction cron already computes. Crew under three
 * completed turnovers in that window have no row at all, which is why the org
 * median is a parameter rather than something this function could look up.
 *
 * Both fall back in turn, and the final constant is a floor rather than a
 * guess at a real job: with no baseline and no median an org is brand new, and
 * a plan built on nothing should still produce a sane-looking day rather than
 * a zero-length one.
 */
export const FALLBACK_MINUTES_PER_BEDROOM = 45
/** A studio is not zero bedrooms of work. */
export const MIN_BEDROOMS_FOR_ESTIMATE = 1

export function estimateMinutes(input: {
  bedrooms:              number | null
  crewMinutesPerBedroom: number | null
  orgMedianPerBedroom:   number | null
}): number {
  const perBedroom =
    input.crewMinutesPerBedroom
    ?? input.orgMedianPerBedroom
    ?? FALLBACK_MINUTES_PER_BEDROOM

  const bedrooms = Math.max(input.bedrooms ?? MIN_BEDROOMS_FOR_ESTIMATE, MIN_BEDROOMS_FOR_ESTIMATE)
  return Math.round(perBedroom * bedrooms)
}
