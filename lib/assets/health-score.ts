import type { PropertyAsset, AssetTypeStandard } from '@/types/database'
import type { StatusDotStatus } from '@/components/ui/StatusDot'

export interface AssetRepairSummary {
  total_repairs:     number
  total_repair_cost: number
  last_serviced_at:  string | null
}

export interface ScoringWeights {
  age:       number  // 30-70, default 60
  condition: number  // 30-70, default 40
}

const DEFAULT_WEIGHTS: ScoringWeights = { age: 60, condition: 40 }

/**
 * Weibull shape parameter for the age-health survival curve — see
 * weibullSurvivalFraction() below. 2.5 sits in the 2–4 range reliability
 * engineering texts use for wear-out failure modes (an "increasing failure
 * rate" curve, as opposed to κ=1's constant-rate exponential decay or κ<1's
 * infant-mortality shape). There's no per-asset-type failure-time data yet
 * to fit a type-specific shape from, so this is a single shared constant —
 * asset_health_score_history exists specifically so a future pass can
 * estimate real per-type shapes from it instead of guessing.
 */
const WEIBULL_SHAPE = 2.5

/**
 * Fraction (0–1) of "as-new" age-health remaining at age `t`, using a
 * Weibull survival curve with characteristic life `eta` (the asset's
 * expected lifespan) and shape `kappa`.
 *
 * This replaces a straight-line `1 - age/lifespan` model. Linear decay is
 * memoryless — an asset loses the same age-health every year regardless of
 * how old it already is — which is not how wear-out actually behaves, and
 * is not what was being modeled here. A Weibull survival curve with κ > 1
 * decays SLOWLY at first (curve stays near 1) and accelerates as `t`
 * approaches and passes `eta`, which is the "ages slowly, then falls off a
 * cliff" shape an asset-health index is supposed to show. At t = eta the
 * curve sits at e⁻¹ ≈ 36.8% (the standard Weibull convention for
 * "characteristic life") rather than 0% — reaching the middle of your
 * expected-lifespan RANGE doesn't mean an asset is dead, and plenty of
 * units run well past it.
 */
export function weibullSurvivalFraction(
  ageYears: number,
  eta:      number,
  kappa:    number = WEIBULL_SHAPE,
): number {
  if (eta <= 0) return 0
  return Math.exp(-Math.pow(Math.max(ageYears, 0) / eta, kappa))
}

export interface HealthScoreBreakdown {
  ageScore:       number
  conditionScore: number
  total:          number
}

/**
 * Pure age + condition breakdown — calculateHealthScore() below is a thin
 * wrapper returning just `.total` for existing callers. Split out so the
 * nightly cron can log age_score/condition_score to
 * asset_health_score_history without recomputing (or duplicating) either
 * half, and so the repair-vs-replace engine can read the condition
 * component on its own.
 */
export function calculateHealthScoreBreakdown(
  asset:         Pick<PropertyAsset, 'installation_date' | 'expected_lifespan_years' | 'estimated_replacement_cost'>,
  standards:     Pick<AssetTypeStandard, 'lifespan_min_years' | 'lifespan_max_years' | 'avg_replacement_cost_high'>
                 // Learned per-type shape (see asset-weibull-shape-fit.ts) — optional so
                 // existing callers that don't carry it still satisfy this type; falls back
                 // to the shared WEIBULL_SHAPE constant via weibullSurvivalFraction's default.
                 & { weibull_shape?: number | null },
  repairHistory: AssetRepairSummary,
  weights:       ScoringWeights = DEFAULT_WEIGHTS,
): HealthScoreBreakdown {
  if (!asset.installation_date) {
    // Split proportionally to whatever weights were passed so ageScore +
    // conditionScore always sums to the same 50 the old flat "Unknown"
    // score returned, regardless of a type's actual age/condition split.
    return { ageScore: weights.age / 2, conditionScore: weights.condition / 2, total: 50 }
  }

  const installYear = new Date(asset.installation_date).getFullYear()
  const currentYear = new Date().getFullYear()
  const ageYears    = Math.max(currentYear - installYear, 0)
  const lifespan    = (asset.expected_lifespan_years
    ?? Math.round((standards.lifespan_min_years + standards.lifespan_max_years) / 2))
    || 10  // guard against 0/0 standard ranges to prevent division by zero

  const ageScore = Math.round(
    weibullSurvivalFraction(ageYears, lifespan, standards.weibull_shape ?? undefined) * weights.age
  )

  const repairsPerYear    = repairHistory.total_repairs / Math.max(ageYears, 1)
  // Penalty caps are proportional to weights.condition (0.5 × 40 = 20, 0.375 × 40 = 15
  // at default weights — matches the original hardcoded caps exactly).
  const repairFreqPenalty = Math.min(weights.condition * 0.5, Math.round(repairsPerYear * 10))

  const replacementCost   = asset.estimated_replacement_cost
    ?? standards.avg_replacement_cost_high
    ?? 5000
  const repairCostPct     = repairHistory.total_repair_cost / (replacementCost || 5000)
  const repairCostPenalty = Math.min(weights.condition * 0.375, Math.round(repairCostPct * 100))

  // last_serviced_at is null for assets with no repair history, which falls
  // through to monthsSinceService = 999 → recencyBonus = 0. That's intentional:
  // an asset that's never been serviced gets no recency bonus, same as one
  // that's long overdue.
  const monthsSinceService = repairHistory.last_serviced_at
    ? Math.floor(
        (Date.now() - new Date(repairHistory.last_serviced_at).getTime())
        / (1000 * 60 * 60 * 24 * 30)
      )
    : 999
  const recencyBonus = monthsSinceService < 6 ? 5 : monthsSinceService < 12 ? 2 : 0

  const conditionScore = Math.max(0, weights.condition - repairFreqPenalty - repairCostPenalty + recencyBonus)
  const total = Math.max(0, Math.min(100, ageScore + conditionScore))

  return { ageScore, conditionScore, total }
}

export function calculateHealthScore(
  asset:         Pick<PropertyAsset, 'installation_date' | 'expected_lifespan_years' | 'estimated_replacement_cost'>,
  standards:     Pick<AssetTypeStandard, 'lifespan_min_years' | 'lifespan_max_years' | 'avg_replacement_cost_high'>
                 & { weibull_shape?: number | null },
  repairHistory: AssetRepairSummary,
  weights:       ScoringWeights = DEFAULT_WEIGHTS,
): number {
  return calculateHealthScoreBreakdown(asset, standards, repairHistory, weights).total
}

export function healthLabel(score: number): string {
  if (score >= 80) return 'Good'
  if (score >= 60) return 'Fair'
  if (score >= 40) return 'Aging'
  if (score >= 20) return 'Poor'
  return 'End of Life'
}

export function healthColor(score: number): string {
  if (score >= 80) return 'var(--accent-green)'
  if (score >= 60) return 'var(--accent-gold)'
  if (score >= 40) return 'var(--accent-amber)'
  if (score >= 20) return 'var(--accent-red)'
  return 'var(--text-muted)'
}

export function healthDot(score: number): StatusDotStatus {
  if (score >= 80) return 'good'
  if (score >= 60) return 'warning'
  if (score >= 40) return 'attention'
  if (score >= 20) return 'critical'
  return 'offline'
}

export function healthBgStyle(score: number): string {
  if (score >= 80) return 'var(--accent-green-dim, rgba(34,197,94,0.1))'
  if (score >= 60) return 'var(--accent-gold-dim,  rgba(250,189,0,0.1))'
  if (score >= 40) return 'var(--accent-amber-dim, rgba(245,158,11,0.1))'
  if (score >= 20) return 'var(--accent-red-dim,   rgba(240,84,84,0.1))'
  return 'var(--border)'
}
