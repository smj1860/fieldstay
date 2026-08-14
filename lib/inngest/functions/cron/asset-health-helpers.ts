import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateHealthScoreBreakdown } from '@/lib/assets/health-score'
import { unwrap, type PostgrestResult } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { buildCapexRecommendation, type CapexRecommendation, type RepairCostWindows } from '@/lib/assets/repair-vs-replace'

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
  name:                        string
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
  age_score:               number
  condition_score:         number
}

export interface ScoreCrossing {
  asset_id:    string
  asset_name:  string
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

    const { ageScore, conditionScore, total: newScore } = calculateHealthScoreBreakdown(
      {
        installation_date:          asset.installation_date,
        expected_lifespan_years:    asset.expected_lifespan_years,
        estimated_replacement_cost: asset.estimated_replacement_cost,
      },
      std,
      repair,
      { age: std.age_weight, condition: std.condition_weight }
    )

    updates.push({
      id:                      asset.id,
      health_score:            newScore,
      health_score_updated_at: now,
      age_score:               ageScore,
      condition_score:         conditionScore,
    })

    // detect threshold crossings (old > threshold >= new)
    const oldScore = asset.health_score
    if (oldScore !== null && newScore !== oldScore) {
      for (const threshold of [60, 40, 20]) {
        if (oldScore > threshold && newScore <= threshold) {
          crossings.push({
            asset_id:    asset.id,
            asset_name:  asset.name,
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

/**
 * Writes the day's scores for one org. Single round trip, and it can only ever
 * UPDATE — it cannot create a property_assets row.
 *
 * This was an `.upsert(..., { onConflict: 'id' })` under the comment "upsert
 * with onConflict: 'id' only updates the columns provided". That belief is
 * wrong, and it meant the score write NEVER once succeeded. PostgREST emits
 * INSERT ... ON CONFLICT (id) DO UPDATE, and Postgres validates NOT NULL on
 * the PROPOSED tuple before resolving the conflict — so a payload of
 * (id, health_score, health_score_updated_at) fails 23502 on org_id every
 * time, even though the row exists and DO UPDATE is the branch that would
 * have run. Not a race, not intermittent: a 100% failure, reproduced against
 * the live schema on an id that already existed.
 *
 * It was invisible for sixteen days because the write result was discarded;
 * the 2026-08-07 read-without-error burn-down is what turned it into a Sentry
 * issue, not what broke it.
 *
 * UPDATE ... FROM jsonb_to_recordset is the shape PostgREST cannot express —
 * per-row values in one statement — so it lives in an RPC
 * (20260808180000_apply_asset_health_scores_rpc.sql). That RPC is
 * SECURITY DEFINER and pins every row it touches to p_org_id.
 *
 * Returns the number of rows actually updated. A shortfall means assets went
 * away between the read and the write, which is normal enough not to throw and
 * useful enough not to swallow — the caller logs it.
 */
export async function persistScores(
  supabase: SupabaseClient,
  orgId:    string,
  updates:  ScoreUpdate[],
): Promise<number> {
  if (!updates.length) return 0

  const res = await supabase.rpc('apply_asset_health_scores', {
    p_org_id:  orgId,
    p_updates: updates.map((u) => ({
      id:                      u.id,
      health_score:            u.health_score,
      health_score_updated_at: u.health_score_updated_at,
    })),
  })

  // orgId and the attempt count are on the context now: the old call passed
  // only `site`, so the Sentry event named the failing query but not the
  // customer it belonged to — the reason the daily failure could be seen but
  // not acted on.
  const updated = unwrap(res as PostgrestResult<number>, {
    site:  'inngest.asset-health.persistScores',
    orgId,
    extra: { assets_attempted: updates.length },
  })

  return updated ?? 0
}

// ── Bayesian weight nudge ─────────────────────────────────────────────────────

export interface WeightStandard {
  asset_type:         string
  age_weight:         number
  condition_weight:   number
  lifespan_min_years: number
  lifespan_max_years: number
}

/**
 * The only two things computeWeightNudge has ever read off a repair history:
 * how many repairs there were, and how many of them landed late in the
 * asset's expected life.
 *
 * It used to take `RepairRecord[]` — one object per completed work order,
 * carrying `repairCost` and `assetType` that NOTHING read. The caller
 * therefore materialised every asset-linked completed work order on the
 * platform, plus its joined property_assets row, to compute two integers per
 * asset type (21 of them). Summarising at the boundary lets the caller fold a
 * page at a time into 21 counters, and drops `actual_cost` from the wire
 * entirely — a field CLAUDE.md bans from logs and which this scan was pulling
 * platform-wide for no reason at all.
 */
export interface NudgeRepairCounts {
  total:    number
  lateLife: number
}

const MAX_NUDGE           = 2.0
const MIN_WEIGHT          = 30
const MAX_WEIGHT          = 70
const MIN_REPAIRS         = 5
const TARGET_LATE_RATIO   = 0.6
/** Fraction of expected lifespan past which a repair counts as "late life". */
const LATE_LIFE_AGE_RATIO = 0.8

/** Midpoint of a standard's lifespan range, with the same 10-year fallback the nudge always used. */
export function lifespanYears(std: WeightStandard): number {
  return Math.round((std.lifespan_min_years + std.lifespan_max_years) / 2) || 10
}

/** Did a repair at `ageAtRepair` years land in the late-life band for this lifespan? */
export function isLateLifeRepair(ageAtRepair: number, lifespan: number): boolean {
  return ageAtRepair / lifespan > LATE_LIFE_AGE_RATIO
}

/**
 * Pure: how aggressively a lifespan standard's age/condition weight should
 * self-correct based on how late in an asset's expected life its repairs
 * tend to land. Returns null when there isn't enough repair history, or the
 * computed nudge is too small to bother persisting.
 */
export function computeWeightNudge(
  repairs: NudgeRepairCounts,
  std:     WeightStandard,
): { age_weight: number; condition_weight: number } | null {
  if (repairs.total < MIN_REPAIRS) return null

  const lateLifeRatio = repairs.lateLife / repairs.total

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

// ── Health score history ─────────────────────────────────────────────────────

export interface HealthHistoryRow {
  org_id:          string
  asset_id:        string
  recorded_date:   string
  health_score:    number
  age_score:       number
  condition_score: number
}

/**
 * Upserts one day's health-score history rows. Every row supplies every
 * NOT NULL column regardless of insert-vs-update branch, so this cannot hit
 * the missing-column NOT NULL trap documented on persistScores above — that
 * bug came from a payload that omitted a NOT NULL column on the UPDATE arm,
 * not from upserting in general.
 */
export async function persistHealthHistory(
  supabase: SupabaseClient,
  rows:     HealthHistoryRow[],
): Promise<void> {
  if (!rows.length) return

  const { error } = await supabase
    .from('asset_health_score_history')
    .upsert(rows, { onConflict: 'asset_id,recorded_date' })

  if (error) {
    throw new Error(`asset_health_score_history upsert failed: ${error.message}`)
  }
}

// ── Repair-vs-Replace ─────────────────────────────────────────────────────────

export interface CapexRecommendationRow {
  org_id:                    string
  asset_id:                  string
  property_id:               string
  recommendation:            CapexRecommendation
  repair_cost_trailing_12mo: number
  repair_cost_prior_12mo:    number
  repair_trend_pct:          number | null
  replacement_cost_estimate: number
  remaining_book_value:      number | null
  reasoning:                 string[]
  computed_at:               string
}

export interface CapexAlert {
  asset_id:  string
  reasoning: string[]
}

/**
 * Upserts this org's repair-vs-replace recommendations, preserving each
 * asset's existing `notified_at` so a routine rescoring never resets the
 * "already alerted" gate (mirrors vendor_compliance_documents.first_warned_at
 * — see the migration comment on this table). Returns the assets that just
 * reached 'replace' for the first time (still un-notified), for the caller's
 * separate notify step.
 */
export async function persistCapexRecommendations(
  supabase: SupabaseClient,
  orgId:    string,
  rows:     CapexRecommendationRow[],
): Promise<CapexAlert[]> {
  if (!rows.length) return []

  // One row per asset — bounded by this org's own asset count, same as the
  // activeAssets read in assetHealthOrg.
  const existing = await fetchAllRows<{ asset_id: string; notified_at: string | null }>(
    (from, to) => supabase
      .from('asset_capex_recommendations')
      .select('asset_id, notified_at')
      .eq('org_id', orgId)
      .order('asset_id', { ascending: true })
      .range(from, to),
    { label: `asset_capex_recommendations[org=${orgId}]` }
  )
  const notifiedAtByAsset = new Map(existing.map((r) => [r.asset_id, r.notified_at]))

  const payload = rows.map((r) => ({
    ...r,
    notified_at: notifiedAtByAsset.get(r.asset_id) ?? null,
  }))

  const { error } = await supabase
    .from('asset_capex_recommendations')
    .upsert(payload, { onConflict: 'asset_id' })

  if (error) {
    throw new Error(`asset_capex_recommendations upsert failed for org ${orgId}: ${error.message}`)
  }

  return rows
    .filter((r) => r.recommendation === 'replace' && !notifiedAtByAsset.get(r.asset_id))
    .map((r) => ({ asset_id: r.asset_id, reasoning: r.reasoning }))
}

/**
 * Latest (max tax_year) ending_adjusted_basis per asset, for the small
 * subset of assets a recommendation run just flagged 'replace' — NOT read
 * for every asset every night, only for the ones that need the
 * informational book-value note in their reasoning.
 */
export async function fetchLatestBookValues(
  supabase: SupabaseClient,
  orgId:    string,
  assetIds: string[],
): Promise<Map<string, number>> {
  if (!assetIds.length) return new Map()

  const entries = await fetchAllRows<{ asset_id: string; tax_year: number; ending_adjusted_basis: number }>(
    (from, to) => supabase
      .from('asset_depreciation_entries')
      .select('asset_id, tax_year, ending_adjusted_basis')
      .eq('org_id', orgId)
      .in('asset_id', assetIds)
      .order('tax_year', { ascending: false })
      .range(from, to),
    { label: `asset_depreciation_entries(latest)[org=${orgId}]` }
  )

  const latestByAsset = new Map<string, number>()
  for (const entry of entries) {
    // Ordered tax_year DESC, so the first row seen per asset is its latest.
    if (!latestByAsset.has(entry.asset_id)) {
      latestByAsset.set(entry.asset_id, entry.ending_adjusted_basis)
    }
  }
  return latestByAsset
}

/**
 * Builds one recommendation row per asset (including the remaining-book-value
 * enrichment pass for whatever came out 'replace') — extracted out of
 * assetHealthOrg's scoring step so that step's own cognitive complexity stays
 * under the CLAUDE.md ceiling. Fetches book values itself, scoped to only the
 * assets that need one (see fetchLatestBookValues).
 */
export async function buildRecommendationRows(
  supabase:        SupabaseClient,
  orgId:           string,
  activeAssets:    AssetRow[],
  standardsByType: Map<string, AssetStandardRow>,
  repairWindows:   Record<string, RepairCostWindows>,
  newScoreByAsset: Map<string, number>,
): Promise<CapexRecommendationRow[]> {
  const nowIso = new Date().toISOString()

  const rows: CapexRecommendationRow[] = activeAssets.map((asset) => {
    const std     = standardsByType.get(asset.asset_type)
    const windows = repairWindows[asset.id] ?? { trailing12mo: 0, prior12mo: 0 }
    const result  = buildCapexRecommendation({
      repairCosts:             windows,
      replacementCostEstimate: asset.estimated_replacement_cost ?? std?.avg_replacement_cost_high ?? null,
      healthScore:             newScoreByAsset.get(asset.id) ?? asset.health_score,
    })
    return {
      org_id:                     orgId,
      asset_id:                   asset.id,
      property_id:                asset.property_id,
      recommendation:             result.recommendation,
      repair_cost_trailing_12mo:  windows.trailing12mo,
      repair_cost_prior_12mo:     windows.prior12mo,
      repair_trend_pct:           result.repairTrendPct,
      replacement_cost_estimate:  result.replacementCostEstimate,
      remaining_book_value:       null,
      reasoning:                  result.reasoning,
      computed_at:                nowIso,
    }
  })

  // Remaining book value is informational only (see repair-vs-replace.ts) and
  // only worth a query for the small subset an asset just got flagged
  // 'replace' — not fetched for every asset every night.
  const replaceCandidateIds = rows.filter((r) => r.recommendation === 'replace').map((r) => r.asset_id)
  const bookValueByAsset    = await fetchLatestBookValues(supabase, orgId, replaceCandidateIds)
  if (!bookValueByAsset.size) return rows

  const assetById = new Map(activeAssets.map((a) => [a.id, a]))
  for (const row of rows) {
    const bookValue = bookValueByAsset.get(row.asset_id)
    if (row.recommendation !== 'replace' || bookValue === undefined) continue

    const asset   = assetById.get(row.asset_id)
    const std     = asset ? standardsByType.get(asset.asset_type) : undefined
    const windows = repairWindows[row.asset_id] ?? { trailing12mo: 0, prior12mo: 0 }
    const result  = buildCapexRecommendation({
      repairCosts:              windows,
      replacementCostEstimate:  row.replacement_cost_estimate ?? std?.avg_replacement_cost_high ?? null,
      healthScore:              newScoreByAsset.get(row.asset_id) ?? asset?.health_score ?? null,
      remainingBookValue:       bookValue,
    })
    row.remaining_book_value = bookValue
    row.reasoning            = result.reasoning
  }

  return rows
}
