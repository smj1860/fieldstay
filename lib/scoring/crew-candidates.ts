/**
 * Crew candidate scoring — the single implementation.
 *
 * Extracted out of auto-assign-turnover.ts so the Friction Forecaster's Smart
 * Fix can produce the same ranking without forking a second scorer. Two
 * scorers would drift, and the drift would be invisible: the board's
 * suggestion and the exceptions panel's Smart Fix would quietly recommend
 * different people for the same turnover, each looking correct on its own.
 *
 * Pure over its inputs. The callers own the queries — which is what keeps the
 * per-row round trips out of it (see unit/guardrails/n-plus-one-loops).
 */

import { haversineKm, proximityScore } from '@/lib/scoring/geo'
import type { PostgrestNumeric } from '@/lib/supabase/unwrap'

/** The crew columns scoring actually reads. Callers may pass wider rows. */
export interface CrewCandidate {
  id:                string
  name:              string
  home_lat:          PostgrestNumeric
  home_lng:          PostgrestNumeric
  reliability_score: PostgrestNumeric
  capacity_score:    PostgrestNumeric
  /**
   * The PM's hard daily cap, or null for no limit (20261012140000). Optional
   * on this type because it is read by atDayCapacity() rather than by the
   * scorer: a candidate that reaches scoring has already cleared the cap.
   */
  max_turnovers_per_day?: number | null
}

export interface CrewScoreBreakdown {
  proximity:   number
  reliability: number
  capacity:    number
  /**
   * The 14-day count, kept as a SMOOTHING term rather than replaced.
   * Persisted to assignment_outcomes.score_breakdown, so a stored row from
   * before dayWorkload existed must stay readable on its own terms — the same
   * reason pre_flight_friction keeps `localEvents: 0`.
   */
  workload:    number
  /** The count for the turnover's OWN date. Added 20261012140000 (Phase D). */
  dayWorkload: number
  familiarity: number
}

export interface ScoredCrewCandidate {
  crew_member_id: string
  name:           string
  score:          number
  breakdown:      CrewScoreBreakdown
}

export interface CrewScoringInput {
  /**
   * Same-day turnovers re-weight toward proximity: there is no slack in the
   * window, so who can physically get there dominates who knows the property.
   */
  isSameDay:       boolean
  property:        { lat: PostgrestNumeric; lng: PostgrestNumeric }
  /**
   * Where each candidate will be coming FROM: the property of their last
   * turnover earlier that same day, or null when this is their first job.
   *
   * Required, not optional, and that is the point of it. Proximity measured
   * from HOME is the wrong origin for anyone already out working — a crew
   * member whose morning job is next door to this one scored as though they
   * were starting from their kitchen — and it carries 15% of the standard
   * weight. An optional field would let one of the two callers omit it, and
   * then the board's suggestion and the Friction Forecaster's Smart Fix would
   * recommend different people for the same turnover, each looking correct in
   * isolation. That drift is the whole reason this module exists.
   *
   * An EMPTY map is a legitimate value meaning "nobody has a prior stop" (and
   * every candidate falls back to home). It is not the same as the field
   * being absent.
   */
  originByCrew:    Record<string, { lat: number | null; lng: number | null } | null>
  crew:            CrewCandidate[]
  familiarCrewIds: string[]
  /** crew_member_id -> assignment count across the 14-day window. */
  workloadMap:     Record<string, number>
  /**
   * crew_member_id -> assignment count on the TURNOVER'S OWN DATE. Required,
   * not optional: an empty default would score every candidate's day as
   * perfectly free, which is harmless for ranking (it is constant across
   * candidates) but writes a confident 1.0 into stored history for a figure
   * nobody measured.
   */
  dayWorkloadMap:  Record<string, number>
}

/**
 * The workload share is SPLIT, 70/30, between the turnover's own day and the
 * 14-day window — every other term is untouched and both sets still total
 * 1.00, so this re-tunes one axis rather than re-tuning the model.
 *
 * Day-first because that is the question being asked: a crew member with four
 * jobs already on this Tuesday is the one to avoid, and the fortnight figure
 * could not see that. The fortnight share is not zero, because a day count
 * alone would happily stack someone's whole week onto consecutive days as
 * long as no single one was crowded.
 */
const SAME_DAY_WEIGHTS = { proximity: 0.40, reliability: 0.30, capacity: 0.15, dayWorkload: 0.07, workload: 0.03, familiarity: 0.05 }
const STANDARD_WEIGHTS = { proximity: 0.15, reliability: 0.25, capacity: 0.10, dayWorkload: 0.14, workload: 0.06, familiarity: 0.30 }

/** Neither home coordinates nor property coordinates — neutral, not a penalty. */
const UNKNOWN_PROXIMITY = 0.5
/** A crew member with no score yet is treated as slightly-below-average, not unusable. */
const DEFAULT_SCORE = 0.7

/**
 * True only for a real, present coordinate value.
 *
 * NOT a truthy check — home_lat/home_lng/lat/lng are PostgrestNumeric, which
 * arrive over PostgREST as STRINGS (see coerceScore's comment below), so a
 * real value of exactly 0 renders as the non-empty string "0.000000". A bare
 * `!value` check is truthy for that string and lets it straight through as a
 * genuine coordinate. And 0 is never a real one here: this is a US-based STR
 * business, and (0°, 0°) — "null island", off the coast of West Africa — is
 * what a failed geocode or an unset/miswritten column looks like once
 * coerced to a number, not a location any crew member or property is
 * actually at. Checked on the PARSED number, since a null check alone still
 * lets the string sentinel through.
 */
function hasCoordinate(value: PostgrestNumeric): boolean {
  if (value === null || value === undefined) return false
  return Number(value) !== 0
}

/**
 * What the candidate is being scored against: the property, plus where each
 * of them would be travelling from.
 *
 * Bundled rather than passed as two parameters so scoreOne() stays inside the
 * 7-parameter ceiling, and because they belong together: a distance is
 * meaningless without both of its ends.
 */
interface ProximityContext {
  property:     CrewScoringInput['property']
  originByCrew: CrewScoringInput['originByCrew']
}

/** A real, present coordinate on a plain-number origin. Same null-island rule. */
function isUsableOrigin(origin: { lat: number | null; lng: number | null } | null): boolean {
  if (!origin || origin.lat === null || origin.lng === null) return false
  if (origin.lat === 0 && origin.lng === 0) return false
  return Number.isFinite(origin.lat) && Number.isFinite(origin.lng)
}

/**
 * Distance from where the candidate will actually be, not from where they
 * live.
 *
 * The previous stop wins when there is one. Home is the fallback for a
 * candidate whose first job of the day this would be, which is the only case
 * where home is genuinely the origin.
 */
function candidateProximity(crew: CrewCandidate, ctx: ProximityContext): number {
  if (!hasCoordinate(ctx.property.lat) || !hasCoordinate(ctx.property.lng)) {
    return UNKNOWN_PROXIMITY
  }

  const from = originFor(crew, ctx)
  if (from === null) return UNKNOWN_PROXIMITY

  return proximityScore(haversineKm(
    from.lat, from.lng,
    Number(ctx.property.lat), Number(ctx.property.lng),
  ))
}

/** The previous stop, else home, else nothing to measure from. */
function originFor(
  crew: CrewCandidate,
  ctx:  ProximityContext,
): { lat: number; lng: number } | null {
  const previous = ctx.originByCrew[crew.id] ?? null
  if (isUsableOrigin(previous)) return { lat: previous!.lat!, lng: previous!.lng! }

  if (hasCoordinate(crew.home_lat) && hasCoordinate(crew.home_lng)) {
    return { lat: Number(crew.home_lat), lng: Number(crew.home_lng) }
  }

  return null
}

/**
 * reliability_score/capacity_score are numeric columns already scaled 0-1
 * (1.000 = 100%), NOT 0-100. They arrive as PostgrestNumeric — a string on the
 * wire — so the coercion is explicit rather than relying on arithmetic
 * coercion.
 */
function coerceScore(value: PostgrestNumeric): number {
  return value !== null && value !== undefined ? Number(value) : DEFAULT_SCORE
}

/**
 * Scores one candidate against pre-resolved weights/denominators. Shared by
 * scoreCrewCandidates() (the full ranked list) and topCrewCandidate() (only
 * the best) so the two can never drift into scoring the same crew member
 * differently.
 */
/**
 * The two workload axes and their denominators, bundled.
 *
 * Four loose parameters took scoreOne past the 7-parameter ceiling, and
 * they belong together anyway: each map is meaningless without the max it is
 * normalised against, and passing them separately is how a caller ends up
 * dividing the day counts by the fortnight's busiest figure.
 */
interface WorkloadContext {
  /** Busiest 14-day count across the pool, floored at 1. */
  maxWorkload:    number
  /** Busiest count on the turnover's own date, floored at 1. */
  maxDay:         number
  workloadMap:    Record<string, number>
  dayWorkloadMap: Record<string, number>
}

function scoreOne(
  c:           CrewCandidate,
  weights:     typeof SAME_DAY_WEIGHTS,
  proximity:   ProximityContext,
  familiarSet: Set<string>,
  load:        WorkloadContext,
): ScoredCrewCandidate {
  const breakdown: CrewScoreBreakdown = {
    proximity:   candidateProximity(c, proximity),
    reliability: coerceScore(c.reliability_score),
    capacity:    coerceScore(c.capacity_score),
    workload:    1 - (load.workloadMap[c.id] ?? 0) / load.maxWorkload,
    dayWorkload: 1 - (load.dayWorkloadMap[c.id] ?? 0) / load.maxDay,
    familiarity: familiarSet.has(c.id) ? 1.0 : 0.0,
  }

  const score =
    breakdown.proximity   * weights.proximity   +
    breakdown.reliability * weights.reliability +
    breakdown.capacity    * weights.capacity    +
    breakdown.workload    * weights.workload    +
    breakdown.dayWorkload * weights.dayWorkload +
    breakdown.familiarity * weights.familiarity

  return { crew_member_id: c.id, name: c.name, score, breakdown }
}

export function scoreCrewCandidates(input: CrewScoringInput): ScoredCrewCandidate[] {
  const { isSameDay, property, crew, familiarCrewIds, workloadMap, dayWorkloadMap, originByCrew } = input
  const proximity: ProximityContext = { property, originByCrew }

  const weights     = isSameDay ? SAME_DAY_WEIGHTS : STANDARD_WEIGHTS
  const familiarSet = new Set(familiarCrewIds)
  const load: WorkloadContext = {
    maxWorkload: Math.max(...Object.values(workloadMap), 1),
    maxDay:      Math.max(...Object.values(dayWorkloadMap), 1),
    workloadMap, dayWorkloadMap,
  }

  return crew
    .map((c) => scoreOne(c, weights, proximity, familiarSet, load))
    .sort((a, b) => b.score - a.score)
}

/**
 * The single best candidate, in one O(n) pass rather than the O(n log n) sort
 * scoreCrewCandidates() does — which every real caller (auto-assign-
 * turnover's suggestion, the Friction Forecaster's Smart Fix) then throws
 * away except for index 0. At a 150-property org's full crew roster scored
 * once per flagged turnover, the discarded sort work is pure waste multiplied
 * by every turnover scored that day.
 *
 * scoreCrewCandidates() stays exported and unchanged for the one caller that
 * genuinely needs the ranked list — its own test suite — and for any future
 * caller that does too.
 */
export function topCrewCandidate(input: CrewScoringInput): ScoredCrewCandidate | null {
  const { isSameDay, property, crew, familiarCrewIds, workloadMap, dayWorkloadMap, originByCrew } = input
  if (!crew.length) return null

  const proximity: ProximityContext = { property, originByCrew }

  const weights     = isSameDay ? SAME_DAY_WEIGHTS : STANDARD_WEIGHTS
  const familiarSet = new Set(familiarCrewIds)
  const load: WorkloadContext = {
    maxWorkload: Math.max(...Object.values(workloadMap), 1),
    maxDay:      Math.max(...Object.values(dayWorkloadMap), 1),
    workloadMap, dayWorkloadMap,
  }

  let best: ScoredCrewCandidate | null = null
  for (const c of crew) {
    const candidate = scoreOne(c, weights, proximity, familiarSet, load)
    if (!best || candidate.score > best.score) best = candidate
  }
  return best
}

/**
 * The human-readable "why this person" line. Deterministic template text, not
 * LLM-generated — it is written to turnovers.suggestion_reasoning and to
 * pre_flight_friction.smart_fix_reasoning, and both are read by a PM deciding
 * whether to trust the pick.
 */
/**
 * Has this crew member already hit the PM's daily cap for that date?
 *
 * A HARD exclusion, applied by the callers BEFORE scoring rather than as a
 * weight inside it. A weight can be outvoted — a very close, very familiar
 * crew member would still win while over their limit — and on the autopilot
 * path there is no human to catch that. Null means no limit, which is what
 * every row carries until a PM sets one.
 *
 * `>=`, not `>`: the count is of assignments ALREADY held on that date, and
 * the turnover being scored is not among them, so someone at exactly their
 * cap is full rather than having one slot left.
 */
export function atDayCapacity(
  crew:     Pick<CrewCandidate, 'max_turnovers_per_day'>,
  dayCount: number,
): boolean {
  const max = crew.max_turnovers_per_day
  if (max === null || max === undefined) return false
  return dayCount >= max
}

export function crewSuggestionReasoning(top: ScoredCrewCandidate): string {
  const reasons: string[] = []
  if (top.breakdown.familiarity === 1) reasons.push('knows this property')
  if (top.breakdown.proximity   > 0.7) reasons.push('nearby')
  if (top.breakdown.reliability > 0.8) reasons.push('high reliability')
  // The DAY figure, not the fortnight one: "light schedule" next to a crew
  // member who already has three jobs that Tuesday reads as wrong to the PM
  // looking at the board, however quiet their fortnight is.
  if (top.breakdown.dayWorkload > 0.8) reasons.push('light schedule')

  return reasons.length ? `${top.name} — ${reasons.join(', ')}` : top.name
}
