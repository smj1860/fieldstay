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

export function calculateHealthScore(
  asset:         Pick<PropertyAsset, 'installation_date' | 'expected_lifespan_years' | 'estimated_replacement_cost'>,
  standards:     Pick<AssetTypeStandard, 'lifespan_min_years' | 'lifespan_max_years' | 'avg_replacement_cost_high'>,
  repairHistory: AssetRepairSummary,
  weights:       ScoringWeights = DEFAULT_WEIGHTS,
): number {
  if (!asset.installation_date) return 50

  const installYear = new Date(asset.installation_date).getFullYear()
  const currentYear = new Date().getFullYear()
  const ageYears    = Math.max(currentYear - installYear, 0)
  const lifespan    = (asset.expected_lifespan_years
    ?? Math.round((standards.lifespan_min_years + standards.lifespan_max_years) / 2))
    || 10  // guard against 0/0 standard ranges to prevent division by zero

  const agePct   = Math.min(ageYears / lifespan, 1.0)
  const ageScore = Math.round((1 - agePct) * weights.age)

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
  return Math.max(0, Math.min(100, ageScore + conditionScore))
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
