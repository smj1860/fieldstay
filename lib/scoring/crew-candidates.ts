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
}

export interface CrewScoreBreakdown {
  proximity:   number
  reliability: number
  capacity:    number
  workload:    number
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
  crew:            CrewCandidate[]
  familiarCrewIds: string[]
  /** crew_member_id -> upcoming assignment count. */
  workloadMap:     Record<string, number>
}

const SAME_DAY_WEIGHTS = { proximity: 0.40, reliability: 0.30, capacity: 0.15, workload: 0.10, familiarity: 0.05 }
const STANDARD_WEIGHTS = { proximity: 0.15, reliability: 0.25, capacity: 0.10, workload: 0.20, familiarity: 0.30 }

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

function candidateProximity(crew: CrewCandidate, property: CrewScoringInput['property']): number {
  if (!hasCoordinate(crew.home_lat) || !hasCoordinate(crew.home_lng)
    || !hasCoordinate(property.lat) || !hasCoordinate(property.lng)) {
    return UNKNOWN_PROXIMITY
  }
  return proximityScore(haversineKm(
    Number(crew.home_lat), Number(crew.home_lng),
    Number(property.lat),  Number(property.lng),
  ))
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
function scoreOne(
  c:           CrewCandidate,
  weights:     typeof SAME_DAY_WEIGHTS,
  property:    CrewScoringInput['property'],
  maxWorkload: number,
  familiarSet: Set<string>,
  workloadMap: Record<string, number>,
): ScoredCrewCandidate {
  const breakdown: CrewScoreBreakdown = {
    proximity:   candidateProximity(c, property),
    reliability: coerceScore(c.reliability_score),
    capacity:    coerceScore(c.capacity_score),
    workload:    1 - (workloadMap[c.id] ?? 0) / maxWorkload,
    familiarity: familiarSet.has(c.id) ? 1.0 : 0.0,
  }

  const score =
    breakdown.proximity   * weights.proximity   +
    breakdown.reliability * weights.reliability +
    breakdown.capacity    * weights.capacity    +
    breakdown.workload    * weights.workload    +
    breakdown.familiarity * weights.familiarity

  return { crew_member_id: c.id, name: c.name, score, breakdown }
}

export function scoreCrewCandidates(input: CrewScoringInput): ScoredCrewCandidate[] {
  const { isSameDay, property, crew, familiarCrewIds, workloadMap } = input

  const weights     = isSameDay ? SAME_DAY_WEIGHTS : STANDARD_WEIGHTS
  const maxWorkload = Math.max(...Object.values(workloadMap), 1)
  const familiarSet = new Set(familiarCrewIds)

  return crew
    .map((c) => scoreOne(c, weights, property, maxWorkload, familiarSet, workloadMap))
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
  const { isSameDay, property, crew, familiarCrewIds, workloadMap } = input
  if (!crew.length) return null

  const weights     = isSameDay ? SAME_DAY_WEIGHTS : STANDARD_WEIGHTS
  const maxWorkload = Math.max(...Object.values(workloadMap), 1)
  const familiarSet = new Set(familiarCrewIds)

  let best: ScoredCrewCandidate | null = null
  for (const c of crew) {
    const candidate = scoreOne(c, weights, property, maxWorkload, familiarSet, workloadMap)
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
export function crewSuggestionReasoning(top: ScoredCrewCandidate): string {
  const reasons: string[] = []
  if (top.breakdown.familiarity === 1) reasons.push('knows this property')
  if (top.breakdown.proximity   > 0.7) reasons.push('nearby')
  if (top.breakdown.reliability > 0.8) reasons.push('high reliability')
  if (top.breakdown.workload    > 0.8) reasons.push('light schedule')

  return reasons.length ? `${top.name} — ${reasons.join(', ')}` : top.name
}
