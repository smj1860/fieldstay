import { describe, it, expect } from 'vitest'
import { inflateCost, buildWhatIfScenario, summarizeScenario } from '@/lib/assets/scenario-modeling'

describe('inflateCost', () => {
  it('returns the base cost unchanged for the current year', () => {
    expect(inflateCost(1000, 2026, 2026, 4)).toBe(1000)
  })

  it('compounds annually at the given rate', () => {
    expect(inflateCost(1000, 2026, 2028, 4)).toBeCloseTo(1000 * 1.04 ** 2, 6)
  })

  it('never applies negative inflation for a target year before the current year', () => {
    expect(inflateCost(1000, 2026, 2020, 4)).toBe(1000)
  })

  it('is a no-op at 0% inflation regardless of horizon', () => {
    expect(inflateCost(1000, 2026, 2036, 0)).toBe(1000)
  })
})

describe('buildWhatIfScenario', () => {
  const projections = {
    2026: { total_low: 1000, total_high: 1500 },
    2027: { total_low: 2000, total_high: 2500 },
  }

  it('leaves the deferred scenario identical to the baseline at deferYears=0', () => {
    const years = buildWhatIfScenario(projections, 2026, 4, 0)
    for (const y of years) {
      expect(y.deferredLow).toBeCloseTo(y.baselineLow, 6)
      expect(y.deferredHigh).toBeCloseTo(y.baselineHigh, 6)
    }
  })

  it('shifts each year forward by the rounded defer amount', () => {
    const years = buildWhatIfScenario(projections, 2026, 0, 2) // 0% inflation isolates the shift
    const y2028 = years.find((y) => y.year === 2028)!
    const y2029 = years.find((y) => y.year === 2029)!
    expect(y2028.deferredLow).toBe(1000)  // 2026's bucket, moved to 2028
    expect(y2029.deferredLow).toBe(2000)  // 2027's bucket, moved to 2029
    // The original years now carry zero deferred cost — it all moved out.
    const y2026 = years.find((y) => y.year === 2026)!
    expect(y2026.deferredLow).toBe(0)
  })

  it('keeps distinct source years distinct after a uniform shift', () => {
    // The shift is the same fixed amount for every year, so two different
    // source years can never land on the same target — each keeps its own
    // total rather than being summed together.
    const years = buildWhatIfScenario(
      { 2026: { total_low: 1000, total_high: 1000 }, 2027: { total_low: 500, total_high: 500 } },
      2026, 0, 1,
    )
    expect(years.find((y) => y.year === 2027)!.deferredLow).toBe(1000)
    expect(years.find((y) => y.year === 2028)!.deferredLow).toBe(500)
  })

  it('rounds a fractional defer amount to the nearest year', () => {
    const years = buildWhatIfScenario({ 2026: { total_low: 1000, total_high: 1000 } }, 2026, 0, 1.5)
    // Math.round(1.5) = 2 in JS (rounds half away from... actually toward +Infinity for .5)
    expect(years.find((y) => y.year === 2028)!.deferredLow).toBe(1000)
  })

  it('applies inflation to the deferred bucket based on its NEW (later) year, not the original one', () => {
    const years = buildWhatIfScenario({ 2026: { total_low: 1000, total_high: 1000 } }, 2026, 4, 2)
    const y2028 = years.find((y) => y.year === 2028)!
    expect(y2028.deferredLow).toBeCloseTo(1000 * 1.04 ** 2, 6)
  })
})

describe('summarizeScenario', () => {
  it('sums each column across years and computes the delta', () => {
    const summary = summarizeScenario([
      { year: 2026, baselineLow: 100, baselineHigh: 150, deferredLow: 0,   deferredHigh: 0 },
      { year: 2027, baselineLow: 0,   baselineHigh: 0,   deferredLow: 110, deferredHigh: 165 },
    ])
    expect(summary.baselineTotalHigh).toBe(150)
    expect(summary.deferredTotalHigh).toBe(165)
    expect(summary.deltaHigh).toBe(15) // deferring cost MORE in real dollars, as inflation would predict
  })
})
