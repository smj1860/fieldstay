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

import { haversineKm } from '@/lib/scoring/geo'

/** Matches the estimate used by app/crew/page.tsx and ops-snapshot.tsx. */
export const AVG_DRIVE_SPEED_KMH = 48 // ~30 mph

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

function travelMinutes(
  from: { lat: number | null; lng: number | null } | null,
  to:   { lat: number | null; lng: number | null },
): number {
  // No previous stop (the first job of the day) means no travel to add. The
  // leg from home is deliberately NOT estimated: crew home coordinates are
  // optional and frequently absent, and inventing a commute would move every
  // start time in the day on data we do not have.
  if (!from) return 0
  if (from.lat === null || from.lng === null || to.lat === null || to.lng === null) return 0

  const km = haversineKm(from.lat, from.lng, to.lat, to.lng)
  return Math.round((km / AVG_DRIVE_SPEED_KMH) * 60)
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
export function planDay(turnovers: readonly PlannableTurnover[]): DayPlan {
  const ordered = [...turnovers].sort(
    (a, b) => Date.parse(a.checkout_datetime) - Date.parse(b.checkout_datetime),
  )

  const slots: PlannedSlot[] = []
  let freeFrom: number | null = null
  let previous: { lat: number | null; lng: number | null } | null = null

  for (const t of ordered) {
    const propertyFree = Date.parse(t.checkout_datetime)
    if (Number.isNaN(propertyFree)) continue

    const travel      = travelMinutes(previous, t)
    const earliestYou = freeFrom === null
      ? propertyFree
      : freeFrom + (travel + ARRIVAL_BUFFER_MINUTES) * MS_PER_MINUTE

    const start = Math.max(propertyFree, earliestYou)
    const end   = start + t.duration_minutes * MS_PER_MINUTE

    // Measured against the guest's arrival, the same bar `was_late` uses.
    // A standalone turnover has no check-in and therefore cannot be late.
    const checkin    = t.checkin_datetime ? Date.parse(t.checkin_datetime) : NaN
    const infeasible = !Number.isNaN(checkin) && end > checkin

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
