/**
 * "What-If" scenario modeling for Capital Planning — pure functions only, no
 * I/O. Operates on the year-bucketed totals already in a CapExProjectionPayload
 * (lib/inngest/functions/capex-projection-core.ts), so the panel that uses
 * this needs no new server read: the page already loads the projection.
 *
 * Two things it answers:
 *  1. What does the 10-year plan look like in real (inflation-adjusted)
 *     dollars, instead of assuming a $1,200 water heater still costs $1,200
 *     in year 6?
 *  2. What does deferring the whole plan by N years do to that total —
 *     the tradeoff between a smaller near-term reserve draw and a larger
 *     inflation-adjusted bill later?
 */

export interface ScenarioYearTotals {
  total_low:  number
  total_high: number
}

export interface ScenarioYear {
  year:         number
  baselineLow:  number
  baselineHigh: number
  deferredLow:  number
  deferredHigh: number
}

/** Compounds a cost forward from `currentYear` to `targetYear` at `annualRatePct`. */
export function inflateCost(baseCost: number, currentYear: number, targetYear: number, annualRatePct: number): number {
  const years = Math.max(0, targetYear - currentYear)
  return baseCost * Math.pow(1 + annualRatePct / 100, years)
}

/**
 * Builds the year-by-year baseline-vs-deferred comparison. Deferral shifts
 * each year's bucket forward by `Math.round(deferYears)` — the projection
 * payload only carries year granularity, so a fractional "defer by 18
 * months" (1.5 years) rounds to the nearest year rather than prorating a
 * bucket across two years, which would imply a precision the input data
 * doesn't have.
 *
 * Deferring does not change WHAT gets replaced or its pre-inflation cost —
 * only WHEN it lands, which changes how much inflation compounds onto it by
 * the time it's actually paid for. That's the whole point of the
 * comparison: the same equipment costs more in real dollars the later you
 * buy it.
 */
export function buildWhatIfScenario(
  projections:      Record<number, ScenarioYearTotals>,
  currentYear:      number,
  inflationRatePct: number,
  deferYears:       number,
): ScenarioYear[] {
  // The shift is the same fixed amount for every source year, and source
  // years are already distinct (they're object keys) — so target years are
  // guaranteed distinct too (a constant shift of distinct integers can't
  // collide). No accumulation logic needed for a case that can't occur.
  const shift = Math.round(deferYears)
  const deferredTotals = new Map<number, ScenarioYearTotals>(
    Object.entries(projections).map(([yearStr, totals]) => [Number(yearStr) + shift, totals])
  )

  const years = new Set([
    ...Object.keys(projections).map(Number),
    ...deferredTotals.keys(),
  ])

  return Array.from(years).sort((a, b) => a - b).map((year) => {
    const baseline = projections[year]      ?? { total_low: 0, total_high: 0 }
    const deferred = deferredTotals.get(year) ?? { total_low: 0, total_high: 0 }
    return {
      year,
      baselineLow:  inflateCost(baseline.total_low,  currentYear, year, inflationRatePct),
      baselineHigh: inflateCost(baseline.total_high, currentYear, year, inflationRatePct),
      deferredLow:  inflateCost(deferred.total_low,  currentYear, year, inflationRatePct),
      deferredHigh: inflateCost(deferred.total_high, currentYear, year, inflationRatePct),
    }
  })
}

export interface ScenarioSummary {
  baselineTotalLow:  number
  baselineTotalHigh: number
  deferredTotalLow:  number
  deferredTotalHigh: number
  /** deferredTotalHigh - baselineTotalHigh — positive means deferring costs more in real dollars. */
  deltaHigh:         number
}

export function summarizeScenario(years: ScenarioYear[]): ScenarioSummary {
  const summary = years.reduce(
    (acc, y) => ({
      baselineTotalLow:  acc.baselineTotalLow  + y.baselineLow,
      baselineTotalHigh: acc.baselineTotalHigh + y.baselineHigh,
      deferredTotalLow:  acc.deferredTotalLow  + y.deferredLow,
      deferredTotalHigh: acc.deferredTotalHigh + y.deferredHigh,
    }),
    { baselineTotalLow: 0, baselineTotalHigh: 0, deferredTotalLow: 0, deferredTotalHigh: 0 },
  )
  return { ...summary, deltaHigh: summary.deferredTotalHigh - summary.baselineTotalHigh }
}
