/**
 * Repair-vs-Replace recommendation engine.
 *
 * Pure functions only — no I/O — so the nightly cron (which already has
 * every input in memory from scoring) can call these directly without a
 * second round trip, and so the decision logic is unit-testable without a
 * Supabase double. Persistence lives in asset_capex_recommendations
 * (supabase/migrations/20260814120000_asset_health_history_and_capex_recommendations.sql),
 * populated from lib/inngest/functions/cron/asset-health.ts.
 *
 * Deliberately NOT a TCO subtraction of "purchase price + install − salvage
 * value − remaining book value" into one number: remaining book value is a
 * tax-timing question, not an operating cost, so it stays a separate
 * informational note rather than netted into the repair-vs-replace ratio.
 *
 * estimatedDowntimeLoss IS folded into the ratio (unlike book value), but it
 * is computed by the caller from two REAL numbers — properties.avg_nightly_rate
 * and the asset's own historical average work-order duration
 * (averageRepairDurationDays below), not a per-asset-type guess. It is a
 * proxy (a work order being open isn't the same as a property being
 * unbookable) rather than a measured "property was unbookable" flag, which
 * this app still does not have — the reasoning text says so explicitly
 * whenever it's a nonzero contributor, rather than presenting it as more
 * precise than it is.
 */

export type CapexRecommendation = 'monitor' | 'repair' | 'replace'

export interface RepairCostWindows {
  /** Sum of actual/estimated repair cost for this asset in the last 12 months. */
  trailing12mo: number
  /** Same sum for the 12 months before that (i.e. months 13–24 ago). */
  prior12mo:    number
}

export interface CapexRecommendationInput {
  repairCosts:              RepairCostWindows
  replacementCostEstimate:  number | null
  healthScore:              number | null
  /** asset_depreciation_entries.ending_adjusted_basis for the most recent tax year, if any. */
  remainingBookValue?:      number | null
  /**
   * properties.avg_nightly_rate × the asset's historical average work-order
   * duration (see averageRepairDurationDays) — a proxy for lost booking
   * revenue while a repair is open, not a measured guest-displacement figure.
   * Folded into the trailing-12mo side of the repair-vs-replace ratio, same
   * as TCO_repair = repair costs + downtime loss.
   */
  estimatedDowntimeLoss?:   number | null
}

export interface CapexRecommendationResult {
  recommendation:           CapexRecommendation
  replacementCostEstimate:  number
  /**
   * Percent change from prior12mo to trailing12mo. NULL when prior12mo is 0
   * — a percentage off a zero base isn't a meaningful number, and reporting
   * it as +Infinity or some clamped placeholder would misrepresent "repairs
   * started this year" as "repairs got astronomically worse."
   */
  repairTrendPct:           number | null
  reasoning:                string[]
}

/**
 * A repair spend at or above this fraction of the replacement cost, in a
 * single trailing 12 months, triggers 'replace' on its own. 50% is the
 * commonly cited rule of thumb in HVAC/appliance repair trades (sometimes
 * "50% rule", occasionally quoted against an asset's age-adjusted value
 * instead of full replacement cost) — a real industry heuristic, not a
 * number invented for this feature.
 */
const REPLACE_REPAIR_RATIO = 0.5

/** Year-over-year repair cost growth at/above this signals a worsening trend. */
const RISING_TREND_PCT = 50

/** health_score below this matches the existing "Poor"/"End of Life" labels (healthLabel() in health-score.ts). */
const POOR_HEALTH_THRESHOLD = 40
const FAIR_HEALTH_THRESHOLD = 60

function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`
}

/** The parenthetical downtime-loss aside for the 'replace' reasoning message, or '' when there's no downtime signal to report. */
function formatDowntimeNote(trailing12mo: number, downtimeLoss: number): string {
  if (downtimeLoss <= 0) return ''
  return ` (${formatMoney(trailing12mo)} in repairs plus an estimated ${formatMoney(downtimeLoss)} in ` +
    `lost booking revenue from this asset's typical repair downtime)`
}

export function buildCapexRecommendation(input: CapexRecommendationInput): CapexRecommendationResult {
  const { repairCosts, healthScore } = input
  const replacementCostEstimate = input.replacementCostEstimate ?? 0

  const repairTrendPct = repairCosts.prior12mo > 0
    ? Math.round(((repairCosts.trailing12mo - repairCosts.prior12mo) / repairCosts.prior12mo) * 100)
    : null

  const reasoning: string[] = []

  if (!input.replacementCostEstimate || input.replacementCostEstimate <= 0) {
    return {
      recommendation: 'monitor',
      replacementCostEstimate: 0,
      repairTrendPct,
      reasoning: ['No replacement cost estimate available for this asset yet.'],
    }
  }

  const downtimeLoss = input.estimatedDowntimeLoss ?? 0
  const tcoRepair    = repairCosts.trailing12mo + downtimeLoss
  const repairRatio  = tcoRepair / replacementCostEstimate
  const risingTrend  = repairTrendPct !== null && repairTrendPct >= RISING_TREND_PCT && repairCosts.trailing12mo > 0
  const poorHealth   = healthScore !== null && healthScore < POOR_HEALTH_THRESHOLD
  const fairHealth   = healthScore !== null && healthScore < FAIR_HEALTH_THRESHOLD

  let recommendation: CapexRecommendation = 'monitor'

  if (repairRatio >= REPLACE_REPAIR_RATIO) {
    recommendation = 'replace'
    const downtimeNote = formatDowntimeNote(repairCosts.trailing12mo, downtimeLoss)
    reasoning.push(
      `Trailing 12-month repair cost${downtimeNote} totals ${formatMoney(tcoRepair)}, ` +
      `${Math.round(repairRatio * 100)}% of the estimated replacement cost ` +
      `(${formatMoney(replacementCostEstimate)}) — at or above the ${Math.round(REPLACE_REPAIR_RATIO * 100)}% ` +
      `repair-vs-replace threshold.`
    )
  } else if (risingTrend && fairHealth) {
    recommendation = 'replace'
    reasoning.push(
      `Repair costs rose ${repairTrendPct}% year over year ` +
      `(${formatMoney(repairCosts.prior12mo)} → ${formatMoney(repairCosts.trailing12mo)}) ` +
      `while health score is ${healthScore}/100.`
    )
  } else if (repairCosts.trailing12mo > 0 && poorHealth) {
    recommendation = 'repair'
    reasoning.push(
      `Health score is ${healthScore}/100 with ${formatMoney(repairCosts.trailing12mo)} in repairs ` +
      `over the last 12 months — below the replace threshold, but worth a closer look.`
    )
  } else if (risingTrend) {
    recommendation = 'repair'
    reasoning.push(
      `Repair costs rose ${repairTrendPct}% year over year ` +
      `(${formatMoney(repairCosts.prior12mo)} → ${formatMoney(repairCosts.trailing12mo)}).`
    )
  }

  if (recommendation === 'replace' && input.remainingBookValue && input.remainingBookValue > 0) {
    reasoning.push(
      `Note: ${formatMoney(input.remainingBookValue)} of remaining depreciable basis would be ` +
      `forfeited by replacing before this asset is fully depreciated — a tax-timing consideration, ` +
      `not a reason on its own to defer.`
    )
  }

  if (!reasoning.length) {
    reasoning.push('No signals — repair costs and health score are within normal range.')
  }

  return { recommendation, replacementCostEstimate, repairTrendPct, reasoning }
}

/**
 * Buckets a set of completed work orders (asset-linked, already date-bounded
 * to REPAIR_HISTORY_WINDOW_DAYS by the caller) into trailing/prior 12-month
 * repair cost sums per asset. Pure — the caller already has this data loaded
 * for the health-score repair-history fold, so this reuses it rather than
 * issuing a second query.
 */
export function bucketRepairCostWindows(
  repairWorkOrders: Array<{ asset_id: string | null; actual_cost: number | null; estimated_cost: number | null; completed_date: string | null }>,
  now: Date,
): Record<string, RepairCostWindows> {
  const twelveMoAgoStr     = new Date(now.getTime() - 365 * 86_400_000).toISOString().split('T')[0]!
  const twentyFourMoAgoStr = new Date(now.getTime() - 730 * 86_400_000).toISOString().split('T')[0]!

  const windows: Record<string, RepairCostWindows> = {}

  for (const wo of repairWorkOrders) {
    if (!wo.asset_id || !wo.completed_date) continue
    // Older than 24 months: no window claims it, so it must not materialize a
    // zero-valued entry either — an asset with only stale repair history
    // should be absent from the map, not present with two zeros.
    if (wo.completed_date < twentyFourMoAgoStr) continue

    const cost   = wo.actual_cost ?? wo.estimated_cost ?? 0
    const bucket = windows[wo.asset_id] ?? { trailing12mo: 0, prior12mo: 0 }
    if (wo.completed_date >= twelveMoAgoStr) {
      bucket.trailing12mo += cost
    } else {
      bucket.prior12mo += cost
    }
    windows[wo.asset_id] = bucket
  }

  return windows
}

/**
 * Average work-order duration (created_at → completed_date, in days) per
 * asset, over whatever completed-repair history the caller passes in — the
 * historical-duration proxy for downtime loss described in this file's
 * header comment. A work order being open is not the same as a property
 * being unbookable for that whole span, which is why this is a proxy and
 * the reasoning text says so, not a claim of measured guest-displacement.
 */
export function averageRepairDurationDays(
  repairWorkOrders: Array<{ asset_id: string | null; created_at: string | null; completed_date: string | null }>,
): Record<string, number> {
  const totals: Record<string, { sumDays: number; count: number }> = {}

  for (const wo of repairWorkOrders) {
    if (!wo.asset_id || !wo.created_at || !wo.completed_date) continue
    const days = (new Date(wo.completed_date).getTime() - new Date(wo.created_at).getTime()) / 86_400_000
    // A negative or zero span is a data artifact (completed_date predating
    // created_at, or a same-instant backfill), not a real same-day repair
    // duration worth averaging in.
    if (days <= 0) continue

    const entry = totals[wo.asset_id] ?? { sumDays: 0, count: 0 }
    entry.sumDays += days
    entry.count   += 1
    totals[wo.asset_id] = entry
  }

  const result: Record<string, number> = {}
  for (const [assetId, { sumDays, count }] of Object.entries(totals)) {
    result[assetId] = sumDays / count
  }
  return result
}
