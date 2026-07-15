import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateHealthScore } from '@/lib/assets/health-score'

/**
 * Helpers for dailyAssetHealth's per-org scoring step and the Bayesian
 * weight-nudge step — extracted out of
 * lib/inngest/functions/cron/asset-health.ts. Each used to combine a pure
 * calculation with I/O (DB writes, email sends) in one step.run() body;
 * splitting the calculation into a named function makes it independently
 * testable, and splitting persist/notify into their own steps means a
 * retry of one can never re-trigger the other (mirrors the vendor
 * dispatch email/SMS split in work-order-events.ts).
 */

// ── Per-org health scoring ───────────────────────────────────────────────────

export interface AssetRow {
  id:                          string
  org_id:                      string
  property_id:                 string
  asset_type:                  string
  installation_date:           string | null
  expected_lifespan_years:     number | null
  estimated_replacement_cost:  number | null
  health_score:                number | null
}

export interface AssetStandardRow {
  asset_type:                string
  lifespan_min_years:        number
  lifespan_max_years:        number
  avg_replacement_cost_high: number
  age_weight:                number
  condition_weight:          number
}

export interface RepairSummary {
  total_repairs:     number
  total_repair_cost: number
  last_serviced_at:  string | null
}

export interface ScoreUpdate {
  id:                      string
  health_score:            number
  health_score_updated_at: string
}

export interface ScoreCrossing {
  asset_type:  string
  property_id: string
  oldScore:    number
  newScore:    number
}

/** Pure: computes each asset's new health score and any threshold crossings. */
export function scoreAssets(
  orgAssets:     AssetRow[],
  standards:     AssetStandardRow[],
  repairByAsset: Record<string, RepairSummary>,
  now:           string,
): { updates: ScoreUpdate[]; crossings: ScoreCrossing[] } {
  const crossings: ScoreCrossing[] = []
  const updates: ScoreUpdate[] = []

  for (const asset of orgAssets) {
    const std = standards.find((s) => s.asset_type === asset.asset_type)
    if (!std) continue

    const repair = repairByAsset[asset.id] ?? {
      total_repairs: 0, total_repair_cost: 0, last_serviced_at: null,
    }

    const newScore = calculateHealthScore(
      {
        installation_date:          asset.installation_date,
        expected_lifespan_years:    asset.expected_lifespan_years,
        estimated_replacement_cost: asset.estimated_replacement_cost,
      },
      std,
      repair,
      { age: std.age_weight, condition: std.condition_weight }
    )

    updates.push({ id: asset.id, health_score: newScore, health_score_updated_at: now })

    // detect threshold crossings (old > threshold >= new)
    const oldScore = asset.health_score
    if (oldScore !== null && newScore !== oldScore) {
      for (const threshold of [60, 40, 20]) {
        if (oldScore > threshold && newScore <= threshold) {
          crossings.push({
            asset_type:  asset.asset_type,
            property_id: asset.property_id,
            oldScore,
            newScore,
          })
          break
        }
      }
    }
  }

  return { updates, crossings }
}

/** Single round trip per org — upsert with onConflict: 'id' only updates the columns provided. */
export async function persistScores(supabase: SupabaseClient, updates: ScoreUpdate[]): Promise<void> {
  if (!updates.length) return

  await supabase
    .from('property_assets')
    .upsert(
      updates.map((u) => ({
        id:                      u.id,
        health_score:            u.health_score,
        health_score_updated_at: u.health_score_updated_at,
      })),
      { onConflict: 'id' }
    )
}

// ── Bayesian weight nudge ─────────────────────────────────────────────────────

export interface WeightStandard {
  asset_type:         string
  age_weight:         number
  condition_weight:   number
  lifespan_min_years: number
  lifespan_max_years: number
}

export interface RepairRecord {
  ageAtRepair: number
  repairCost:  number
  assetType:   string
}

const MAX_NUDGE         = 2.0
const MIN_WEIGHT        = 30
const MAX_WEIGHT        = 70
const MIN_REPAIRS       = 5
const TARGET_LATE_RATIO = 0.6

/**
 * Pure: how aggressively a lifespan standard's age/condition weight should
 * self-correct based on how late in an asset's expected life its repairs
 * tend to land. Returns null when there isn't enough repair history, or the
 * computed nudge is too small to bother persisting.
 */
export function computeWeightNudge(
  repairs: RepairRecord[],
  std:     WeightStandard,
): { age_weight: number; condition_weight: number } | null {
  if (repairs.length < MIN_REPAIRS) return null

  const lifespan = Math.round((std.lifespan_min_years + std.lifespan_max_years) / 2) || 10

  const lateLifeRepairs = repairs.filter((r) => r.ageAtRepair / lifespan > 0.8).length
  const lateLifeRatio   = lateLifeRepairs / repairs.length

  let ageNudge = 0
  if (lateLifeRatio > TARGET_LATE_RATIO) {
    ageNudge = +MAX_NUDGE * ((lateLifeRatio - TARGET_LATE_RATIO) / (1 - TARGET_LATE_RATIO))
  } else if (lateLifeRatio < (1 - TARGET_LATE_RATIO)) {
    ageNudge = -MAX_NUDGE * ((TARGET_LATE_RATIO - lateLifeRatio) / TARGET_LATE_RATIO)
  }

  if (Math.abs(ageNudge) < 0.1) return null

  const newAgeWeight  = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, std.age_weight + ageNudge))
  const newCondWeight = 100 - newAgeWeight

  if (Math.abs(newAgeWeight - std.age_weight) < 0.05) return null

  return {
    age_weight:       Math.round(newAgeWeight * 10) / 10,
    condition_weight: Math.round(newCondWeight * 10) / 10,
  }
}
