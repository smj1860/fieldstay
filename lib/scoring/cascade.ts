/**
 * Cascade ranking: how far a running-late turnover is projected to eat into
 * the crew member's NEXT job.
 *
 * PURE over its inputs. The caller owns every query.
 *
 * ── Why one derived number and not a weighted composite ──
 * The obvious design is a score over several factors: how late, how far along,
 * how far to drive, how big the property. Two of those are mostly absent from
 * real data — on the live portfolio, 17/59 properties have coordinates and
 * 10/59 have square footage, against 59/59 with bedrooms — so a composite
 * would look authoritative while being computed largely from nulls. That is
 * worse than no ranking at all.
 *
 * Projected overrun absorbs the factors that ARE measurable into one quantity
 * with units a person can act on: "running 40 minutes into the next job". A
 * rank nobody can explain in a sentence is one nobody trusts at 7am, and
 * hand-set weights here would stay unvalidated indefinitely — CLAUDE.md is
 * explicit that the friction scorer's weights are never auto-tuned.
 *
 * ── It ranks. It does not decide. ──
 * No severity, no auto-reassignment, no threshold that triggers anything.
 * Ordering a list is presentation; the dispatcher still decides. That is the
 * constraint lib/scoring/crew-day-context.ts carries and this keeps.
 */

import { haversineKm } from '@/lib/scoring/geo'
import { AVG_DRIVE_SPEED_KMH, ARRIVAL_BUFFER_MINUTES } from '@/lib/planning/day-plan'

export interface CascadeJob {
  turnoverId:       string
  propertyName:     string | null
  /** When this job is due to start. Planned time if published, else checkout. */
  startAt:          string
  /** The guest's arrival. The bar `was_late` uses; null on a standalone. */
  checkinAt:        string | null
  lat:              number | null
  lng:              number | null
  /** Estimated total minutes of work (bedrooms x the crew member's own speed). */
  durationMinutes:  number
  /**
   * completed items / total. null = no checklist instance yet, which is NOT
   * zero progress: it is no information. Treated as "not started" for the
   * remaining-work estimate, and said so in the label rather than implied.
   */
  completionRatio:  number | null
}

export interface CascadeRisk {
  turnoverId:        string
  propertyName:      string | null
  /** Minutes past this job's own check-in, right now. */
  minutesLate:       number
  /**
   * Projected minutes this job runs into the NEXT one's start, including
   * travel. Zero when there is no next job, which is why `hasDownstream`
   * exists rather than leaving a reader to infer it from a zero.
   */
  overrunMinutes:    number
  hasDownstream:     boolean
  nextTurnoverId:    string | null
  nextPropertyName:  string | null
  /** True when the travel leg could not be estimated (missing coordinates). */
  travelUnknown:     boolean
}

const MS_PER_MINUTE = 60_000

function travelMinutes(from: CascadeJob, to: CascadeJob): { minutes: number; known: boolean } {
  if (from.lat === null || from.lng === null || to.lat === null || to.lng === null) {
    // Contributes ZERO rather than a guess, and says so. Same honest-absence
    // convention as an unmapped ZIP scoring 'none' in the seasonal profile:
    // a fabricated drive time would move the ranking on data we do not have.
    return { minutes: 0, known: false }
  }
  const km = haversineKm(from.lat, from.lng, to.lat, to.lng)
  return { minutes: Math.round((km / AVG_DRIVE_SPEED_KMH) * 60), known: true }
}

/**
 * Minutes of work still to do.
 *
 * A null ratio means no checklist instance exists yet, so none of the work is
 * done — the full duration remains. That is deliberately the pessimistic
 * reading: under-reporting a cascade is the failure that matters here, since
 * the whole point is to surface a problem before it lands.
 */
function remainingMinutes(job: CascadeJob): number {
  const done = job.completionRatio === null ? 0 : Math.min(Math.max(job.completionRatio, 0), 1)
  return Math.round(job.durationMinutes * (1 - done))
}

/**
 * Ranks one crew member's running-late jobs, worst first.
 *
 * `jobs` is that crew member's whole day. Order is irrelevant: it is sorted
 * by start time here, because "the next job" has to mean the next one by the
 * clock and a caller's array order is not a promise.
 */
export function rankCascadeRisk(jobs: readonly CascadeJob[], now: number): CascadeRisk[] {
  const ordered = [...jobs].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))

  const risks: CascadeRisk[] = []

  for (let i = 0; i < ordered.length; i++) {
    const job = ordered[i]!
    if (!job.checkinAt) continue            // standalone: no guest, cannot be late

    const checkin = Date.parse(job.checkinAt)
    if (Number.isNaN(checkin) || now <= checkin) continue

    // Past its own check-in AND still unfinished. A finished job that ran long
    // is history, not a cascade.
    if (job.completionRatio !== null && job.completionRatio >= 1) continue

    const minutesLate = Math.round((now - checkin) / MS_PER_MINUTE)
    const next = ordered[i + 1]

    if (!next) {
      risks.push({
        turnoverId: job.turnoverId, propertyName: job.propertyName,
        minutesLate, overrunMinutes: 0, hasDownstream: false,
        nextTurnoverId: null, nextPropertyName: null, travelUnknown: false,
      })
      continue
    }

    const travel      = travelMinutes(job, next)
    const finishesAt  = now + remainingMinutes(job) * MS_PER_MINUTE
    const arrivesAt   = finishesAt + (travel.minutes + ARRIVAL_BUFFER_MINUTES) * MS_PER_MINUTE
    const nextStart   = Date.parse(next.startAt)

    const overrun = Number.isNaN(nextStart)
      ? 0
      : Math.max(0, Math.round((arrivesAt - nextStart) / MS_PER_MINUTE))

    risks.push({
      turnoverId: job.turnoverId, propertyName: job.propertyName,
      minutesLate, overrunMinutes: overrun, hasDownstream: true,
      nextTurnoverId: next.turnoverId, nextPropertyName: next.propertyName,
      travelUnknown: !travel.known,
    })
  }

  // Worst first: the job eating most into the next one, then by how late it
  // already is. A job with nothing downstream ranks last among equals, because
  // it is the one case where being late costs nobody else their window.
  return risks.sort((a, b) =>
    b.overrunMinutes - a.overrunMinutes || b.minutesLate - a.minutesLate)
}
