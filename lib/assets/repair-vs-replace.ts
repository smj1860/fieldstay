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
 * tax-timing question, not an operating cost, and estimated downtime loss
 * has no real data source anywhere in this app today (no property carries a
 * per-night rate, no work order carries a "property was unbookable" flag).
 * Fabricating a downtime-cost assumption to plug into a formula would make
 * the number LESS trustworthy than leaving it out — see CLAUDE.md's rule
 * against error handling/inputs for scenarios that can't happen, applied
 * here to "don't invent data that doesn't exist." What's below uses only
 * numbers the app actually has: repair cost history and a replacement cost
 * estimate, with book value surfaced as a separate informational note.
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

  const repairRatio = repairCosts.trailing12mo / replacementCostEstimate
  const risingTrend  = repairTrendPct !== null && repairTrendPct >= RISING_TREND_PCT && repairCosts.trailing12mo > 0
  const poorHealth   = healthScore !== null && healthScore < POOR_HEALTH_THRESHOLD
  const fairHealth   = healthScore !== null && healthScore < FAIR_HEALTH_THRESHOLD

  let recommendation: CapexRecommendation = 'monitor'

  if (repairRatio >= REPLACE_REPAIR_RATIO) {
    recommendation = 'replace'
    reasoning.push(
      `Trailing 12-month repair spend (${formatMoney(repairCosts.trailing12mo)}) is ` +
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
