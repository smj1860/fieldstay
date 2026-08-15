import { describe, it, expect } from 'vitest'
import { fitWeibullShape } from '@/lib/assets/weibull-fit'

/** Builds n ages whose empirical median ranks exactly match a Weibull(kappa, eta) CDF. */
function syntheticAges(n: number, kappa: number, eta: number): number[] {
  const ages: number[] = []
  for (let i = 1; i <= n; i++) {
    const medianRank = (i - 0.3) / (n + 0.4)
    ages.push(eta * Math.pow(-Math.log(1 - medianRank), 1 / kappa))
  }
  return ages
}

describe('fitWeibullShape', () => {
  it('returns null with fewer than 8 samples', () => {
    expect(fitWeibullShape([5, 6, 7, 8, 9, 10, 11])).toBeNull()
  })

  it('returns null when every age is non-positive', () => {
    expect(fitWeibullShape([0, -1, -2, 0, 0, -3, -4, -5])).toBeNull()
  })

  it('returns null when every age is identical (no slope to fit)', () => {
    expect(fitWeibullShape(Array(10).fill(12))).toBeNull()
  })

  it('recovers a known shape parameter from synthetic Weibull-distributed ages', () => {
    const ages = syntheticAges(20, 3.0, 12)
    const result = fitWeibullShape(ages)
    expect(result).not.toBeNull()
    expect(result!.shape).toBeCloseTo(3.0, 1)
    expect(result!.sampleSize).toBe(20)
  })

  it('recovers a different known shape parameter (steeper wear-out curve)', () => {
    const ages = syntheticAges(15, 5.0, 8)
    const result = fitWeibullShape(ages)
    expect(result).not.toBeNull()
    expect(result!.shape).toBeCloseTo(5.0, 1)
  })

  it('filters out non-positive ages before fitting rather than crashing', () => {
    const ages = [...syntheticAges(20, 3.0, 12), 0, -1, -2]
    const result = fitWeibullShape(ages)
    expect(result).not.toBeNull()
    expect(result!.sampleSize).toBe(20)
  })

  it('clamps an out-of-range fit to the DB CHECK bounds (1.0-8.0)', () => {
    // A near-constant-with-one-outlier sample can produce a very steep or very
    // shallow slope — the clamp exists so a noisy small sample cannot push a
    // stored shape somewhere the CHECK constraint (and the curve itself)
    // would reject or misbehave on.
    const ages = [10, 10.001, 10.002, 10.003, 10.004, 10.005, 10.006, 30]
    const result = fitWeibullShape(ages)
    expect(result).not.toBeNull()
    expect(result!.shape).toBeGreaterThanOrEqual(1.0)
    expect(result!.shape).toBeLessThanOrEqual(8.0)
  })
})
