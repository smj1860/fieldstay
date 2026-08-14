import { describe, it, expect } from 'vitest'
import { buildCapexRecommendation, bucketRepairCostWindows } from '@/lib/assets/repair-vs-replace'

describe('buildCapexRecommendation', () => {
  it('recommends monitor with no reasoning signals when repair costs and health are unremarkable', () => {
    const result = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 200, prior12mo: 200 },
      replacementCostEstimate: 6000,
      healthScore:             85,
    })
    expect(result.recommendation).toBe('monitor')
    expect(result.reasoning).toEqual(['No signals — repair costs and health score are within normal range.'])
  })

  it('recommends monitor with no crash when there is no replacement cost estimate at all', () => {
    const result = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 500, prior12mo: 0 },
      replacementCostEstimate: null,
      healthScore:             50,
    })
    expect(result.recommendation).toBe('monitor')
    expect(result.replacementCostEstimate).toBe(0)
    expect(result.reasoning).toEqual(['No replacement cost estimate available for this asset yet.'])
  })

  it('recommends replace when trailing 12mo repair spend is at least 50% of replacement cost (the industry rule of thumb)', () => {
    const result = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 3000, prior12mo: 0 },
      replacementCostEstimate: 6000,
      healthScore:             70,
    })
    expect(result.recommendation).toBe('replace')
    expect(result.reasoning[0]).toContain('50%')
    expect(result.reasoning[0]).toContain('$3,000')
    expect(result.reasoning[0]).toContain('$6,000')
  })

  it('does NOT trigger the 50% rule just under the threshold', () => {
    const result = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 2999, prior12mo: 0 },
      replacementCostEstimate: 6000,
      healthScore:             70,
    })
    expect(result.recommendation).not.toBe('replace')
  })

  it('recommends replace on a rising repair-cost trend combined with fair-or-worse health', () => {
    const result = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 900, prior12mo: 500 }, // +80%
      replacementCostEstimate: 6000,
      healthScore:             55, // below the 60 "fair" threshold
    })
    expect(result.recommendation).toBe('replace')
    expect(result.repairTrendPct).toBe(80)
    expect(result.reasoning[0]).toContain('80%')
  })

  it('does not treat a rising trend as a replace signal when health is still good', () => {
    const result = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 900, prior12mo: 500 }, // +80%
      replacementCostEstimate: 6000,
      healthScore:             75, // above the "fair" threshold
    })
    expect(result.recommendation).toBe('repair')
  })

  it('recommends repair (not replace) for poor health with some repair spend below the replace ratio', () => {
    const result = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 400, prior12mo: 400 }, // flat trend
      replacementCostEstimate: 6000,
      healthScore:             35, // below "poor" threshold
    })
    expect(result.recommendation).toBe('repair')
    expect(result.reasoning[0]).toContain('35/100')
  })

  it('reports repairTrendPct as null (not Infinity) when there were no repairs in the prior window', () => {
    const result = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 400, prior12mo: 0 },
      replacementCostEstimate: 6000,
      healthScore:             80,
    })
    expect(result.repairTrendPct).toBeNull()
  })

  it('appends the remaining-book-value note only when the recommendation is replace', () => {
    const replace = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 4000, prior12mo: 0 },
      replacementCostEstimate: 6000,
      healthScore:             50,
      remainingBookValue:      1200,
    })
    expect(replace.recommendation).toBe('replace')
    expect(replace.reasoning.some((r) => r.includes('$1,200') && r.includes('tax-timing'))).toBe(true)

    const monitor = buildCapexRecommendation({
      repairCosts:             { trailing12mo: 0, prior12mo: 0 },
      replacementCostEstimate: 6000,
      healthScore:             90,
      remainingBookValue:      1200,
    })
    expect(monitor.recommendation).toBe('monitor')
    expect(monitor.reasoning.some((r) => r.includes('tax-timing'))).toBe(false)
  })
})

describe('bucketRepairCostWindows', () => {
  const NOW = new Date('2026-08-14T00:00:00.000Z')

  it('buckets costs into trailing and prior 12-month windows per asset', () => {
    const windows = bucketRepairCostWindows([
      { asset_id: 'a1', actual_cost: 300, estimated_cost: null, completed_date: '2026-06-01' }, // trailing
      { asset_id: 'a1', actual_cost: 200, estimated_cost: null, completed_date: '2025-06-01' }, // prior
      { asset_id: 'a2', actual_cost: 100, estimated_cost: null, completed_date: '2026-07-01' }, // trailing
    ], NOW)

    expect(windows.a1).toEqual({ trailing12mo: 300, prior12mo: 200 })
    expect(windows.a2).toEqual({ trailing12mo: 100, prior12mo: 0 })
  })

  it('falls back to estimated_cost when actual_cost is null', () => {
    const windows = bucketRepairCostWindows([
      { asset_id: 'a1', actual_cost: null, estimated_cost: 250, completed_date: '2026-06-01' },
    ], NOW)
    expect(windows.a1?.trailing12mo).toBe(250)
  })

  it('ignores rows with no asset_id or no completed_date', () => {
    const windows = bucketRepairCostWindows([
      { asset_id: null, actual_cost: 300, estimated_cost: null, completed_date: '2026-06-01' },
      { asset_id: 'a1', actual_cost: 300, estimated_cost: null, completed_date: null },
    ], NOW)
    expect(windows).toEqual({})
  })

  it('drops costs older than 24 months entirely', () => {
    const windows = bucketRepairCostWindows([
      { asset_id: 'a1', actual_cost: 999, estimated_cost: null, completed_date: '2023-01-01' },
    ], NOW)
    expect(windows.a1).toBeUndefined()
  })
})
