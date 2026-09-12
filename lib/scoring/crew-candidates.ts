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

/** The crew columns scoring actually reads. Callers may pass wider rows. */
export interface CrewCandidate {
  id:                string
  name:              string
  home_lat:          number | string | null
  home_lng:          number | string | null
  reliability_score: number | string | null
  capacity_score:    number | string | null
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
  property:        { lat: number | string | null; lng: number | string | null }
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

function candidateProximity(crew: CrewCandidate, property: CrewScoringInput['property']): number {
  if (!crew.home_lat || !crew.home_lng || !property.lat || !property.lng) return UNKNOWN_PROXIMITY
  return proximityScore(haversineKm(
    Number(crew.home_lat), Number(crew.home_lng),
    Number(property.lat),  Number(property.lng),
  ))
}

/**
 * reliability_score/capacity_score are numeric columns already scaled 0-1
 * (1.000 = 100%), NOT 0-100. PostgREST also returns numeric as STRINGS, so the
 * coercion is explicit rather than relying on arithmetic coercion.
 */
function coerceScore(value: number | string | null): number {
  return value !== null && value !== undefined ? Number(value) : DEFAULT_SCORE
}

export function scoreCrewCandidates(input: CrewScoringInput): ScoredCrewCandidate[] {
  const { isSameDay, property, crew, familiarCrewIds, workloadMap } = input

  const weights     = isSameDay ? SAME_DAY_WEIGHTS : STANDARD_WEIGHTS
  const maxWorkload = Math.max(...Object.values(workloadMap), 1)
  const familiarSet = new Set(familiarCrewIds)

  return crew
    .map((c) => {
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
    })
    .sort((a, b) => b.score - a.score)
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
