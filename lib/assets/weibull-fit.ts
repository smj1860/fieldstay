/**
 * Fits the Weibull shape parameter (kappa) for an asset type from observed
 * ages-at-replacement (see WEIBULL_SHAPE in health-score.ts for what the
 * shape parameter means, and property_assets.replaced_at for where the
 * ground truth comes from).
 *
 * Method: median-rank regression on the Weibull probability plot — the
 * standard lightweight technique (no external stats library, same spirit as
 * the hand-written Bayesian weight nudge in asset-health-helpers.ts): sort
 * the ages, assign each its median rank via Bernard's approximation, then a
 * least-squares fit of ln(-ln(1-F)) against ln(age) recovers kappa as the
 * slope of that line.
 */

export interface WeibullFitResult {
  shape:      number
  sampleSize: number
}

/**
 * Fewer than this many replacement events and a probability-plot fit is
 * noise, not a curve — regression through a handful of points is unstable
 * enough that a single outlier can swing the slope wildly. 8 is a
 * conservative floor for this method (textbook guidance for Weibull
 * probability plots generally wants at least this many).
 */
const MIN_REPLACEMENTS = 8

/** Matches the DB CHECK on asset_type_standards.weibull_shape. */
const MIN_SHAPE = 1.0
const MAX_SHAPE = 8.0

export function fitWeibullShape(agesYears: number[]): WeibullFitResult | null {
  // A same-day "replacement" is a data error, not a lifespan of zero — ln(0)
  // is undefined, and a genuine zero would corrupt the regression anyway.
  const ages = agesYears.filter((a) => a > 0).sort((a, b) => a - b)
  const n = ages.length
  if (n < MIN_REPLACEMENTS) return null

  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < n; i++) {
    const medianRank = (i + 1 - 0.3) / (n + 0.4)
    xs.push(Math.log(ages[i]!))
    ys.push(Math.log(-Math.log(1 - medianRank)))
  }

  const meanX = xs.reduce((s, x) => s + x, 0) / n
  const meanY = ys.reduce((s, y) => s + y, 0) / n

  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i++) {
    numerator   += (xs[i]! - meanX) * (ys[i]! - meanY)
    denominator += (xs[i]! - meanX) ** 2
  }

  // Every age identical, or close enough that floating-point rounding on
  // ln() no longer resolves a real difference (e.g. a bulk-replaced batch
  // with no meaningful spread) — there is no slope to recover, not a
  // divide-by-zero to paper over. An exact `=== 0` check is not reliable
  // here: summing/averaging identical floats does not always round-trip
  // to bit-identical values, so a near-zero denominator can still produce
  // a division result, just a meaningless (and potentially huge) one.
  if (denominator < 1e-9) return null

  const shape   = numerator / denominator
  const clamped = Math.min(MAX_SHAPE, Math.max(MIN_SHAPE, shape))

  return { shape: Math.round(clamped * 100) / 100, sampleSize: n }
}
