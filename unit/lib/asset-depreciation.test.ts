import { describe, it, expect } from 'vitest'
import { getMacrsRate, calculateAnnualDepreciation, MACRS_LABELS } from '@/lib/assets/depreciation'
import type { MacrsClass } from '@/types/database'

describe('getMacrsRate', () => {
  it('returns the correct 5-year MACRS table rates for years 1-5', () => {
    expect(getMacrsRate('5_year', 1)).toBe(0.2000)
    expect(getMacrsRate('5_year', 2)).toBe(0.3200)
    expect(getMacrsRate('5_year', 3)).toBe(0.1920)
    expect(getMacrsRate('5_year', 4)).toBe(0.1152)
    expect(getMacrsRate('5_year', 5)).toBe(0.1152)
  })

  it('true-ups the final 5-year MACRS year to whatever completes exactly 100% recovery', () => {
    // Table rows 1-5 for 5-year MACRS sum to 0.9424 (not the flat 0.0576 table
    // value once floating point is involved) — the final year absorbs the
    // remainder rather than using the table's own (rounded) last entry.
    const rate = getMacrsRate('5_year', 6)
    expect(rate).toBeCloseTo(0.0576, 10)
  })

  it('true-ups the final 15-year MACRS year to complete exactly 100% recovery', () => {
    // The published 15-year table sums to 0.9996 (IRS rounding), so the
    // correct final-year rate to reach exactly 100% is 0.0299 — not simply
    // reusing the table's own last entry (0.0295).
    const rate = getMacrsRate('15_year', 16)
    expect(rate).toBeCloseTo(0.0299, 4)
  })

  it('returns 0 for a year beyond the MACRS table length', () => {
    expect(getMacrsRate('5_year', 7)).toBe(0)
    expect(getMacrsRate('15_year', 17)).toBe(0)
  })

  it('returns 0 for year 0 or negative years of service', () => {
    expect(getMacrsRate('5_year', 0)).toBe(0)
    expect(getMacrsRate('5_year', -1)).toBe(0)
  })

  it('returns the straight-line rate for 27.5-year property regardless of year', () => {
    expect(getMacrsRate('27_5_year', 1)).toBeCloseTo(1 / 27.5, 10)
    expect(getMacrsRate('27_5_year', 20)).toBeCloseTo(1 / 27.5, 10)
  })

  it('returns the straight-line rate for 39-year property regardless of year', () => {
    expect(getMacrsRate('39_year', 1)).toBeCloseTo(1 / 39, 10)
    expect(getMacrsRate('39_year', 30)).toBeCloseTo(1 / 39, 10)
  })

  it('expenses 100% of section 179 property in year 1 and 0% thereafter', () => {
    expect(getMacrsRate('section_179', 1)).toBe(1.0)
    expect(getMacrsRate('section_179', 2)).toBe(0)
    expect(getMacrsRate('section_179', 0)).toBe(0)
  })
})

describe('calculateAnnualDepreciation', () => {
  const baseAsset = {
    id:                     'asset_1',
    org_id:                 'org_1',
    placed_in_service_date: '2020-01-01',
    purchase_price:         10000,
    salvage_value:          0,
    macrs_class:            '5_year' as MacrsClass,
  }

  it('returns null when placed_in_service_date is missing', () => {
    const asset = { ...baseAsset, placed_in_service_date: null }
    expect(calculateAnnualDepreciation(asset, 2020, 0)).toBeNull()
  })

  it('returns null when purchase_price is missing', () => {
    const asset = { ...baseAsset, purchase_price: null }
    expect(calculateAnnualDepreciation(asset, 2020, 0)).toBeNull()
  })

  it('returns null for a tax year before the asset was placed in service', () => {
    expect(calculateAnnualDepreciation(baseAsset, 2019, 0)).toBeNull()
  })

  it('calculates year-1 depreciation correctly for 5-year MACRS property', () => {
    const entry = calculateAnnualDepreciation(baseAsset, 2020, 0)
    expect(entry).not.toBeNull()
    expect(entry!.cost_basis).toBe(10000)
    expect(entry!.depreciation_rate).toBe(0.2000)
    expect(entry!.current_year_depreciation).toBe(2000)
    expect(entry!.prior_cumulative_depreciation).toBe(0)
    expect(entry!.ending_adjusted_basis).toBe(8000)
    expect(entry!.tax_year).toBe(2020)
    expect(entry!.macrs_class).toBe('5_year')
    expect(entry!.asset_id).toBe('asset_1')
    expect(entry!.org_id).toBe('org_1')
  })

  it('calculates the true-up final year of 5-year MACRS correctly', () => {
    // Year 6 (2025) is the final year for 5-year property placed in service
    // in 2020. priorCumulative reflects all prior years already applied.
    const priorCumulative = 2000 + 3200 + 1920 + 1152 + 1152 // years 1-5
    const entry = calculateAnnualDepreciation(baseAsset, 2025, priorCumulative)
    expect(entry).not.toBeNull()
    expect(entry!.current_year_depreciation).toBeCloseTo(576, 1)
    expect(entry!.ending_adjusted_basis).toBeCloseTo(0, 1)
  })

  it('returns zero depreciation for a year beyond the MACRS schedule', () => {
    const entry = calculateAnnualDepreciation(baseAsset, 2027, 10000) // year 8, fully depreciated
    expect(entry).not.toBeNull()
    expect(entry!.depreciation_rate).toBe(0)
    expect(entry!.current_year_depreciation).toBe(0)
    expect(entry!.ending_adjusted_basis).toBe(0)
  })

  it('subtracts salvage_value from the cost basis before applying the rate', () => {
    const asset = { ...baseAsset, salvage_value: 1000 }
    const entry = calculateAnnualDepreciation(asset, 2020, 0)
    expect(entry!.cost_basis).toBe(9000)
    expect(entry!.current_year_depreciation).toBe(1800) // 9000 * 0.20
  })

  it('expenses the full cost basis in year 1 for section 179 property', () => {
    const asset = { ...baseAsset, macrs_class: 'section_179' as MacrsClass }
    const entry = calculateAnnualDepreciation(asset, 2020, 0)
    expect(entry!.current_year_depreciation).toBe(10000)
    expect(entry!.ending_adjusted_basis).toBe(0)
  })

  it('returns zero depreciation for section 179 property in year 2', () => {
    const asset = { ...baseAsset, macrs_class: 'section_179' as MacrsClass }
    const entry = calculateAnnualDepreciation(asset, 2021, 10000)
    expect(entry!.current_year_depreciation).toBe(0)
  })

  it('applies straight-line depreciation for 27.5-year property', () => {
    const asset = { ...baseAsset, macrs_class: '27_5_year' as MacrsClass, purchase_price: 27500 }
    const entry = calculateAnnualDepreciation(asset, 2020, 0)
    expect(entry!.depreciation_rate).toBeCloseTo(1 / 27.5, 10)
    expect(entry!.current_year_depreciation).toBe(1000)
  })

  it('applies straight-line depreciation for 39-year property', () => {
    const asset = { ...baseAsset, macrs_class: '39_year' as MacrsClass, purchase_price: 39000 }
    const entry = calculateAnnualDepreciation(asset, 2020, 0)
    expect(entry!.depreciation_rate).toBeCloseTo(1 / 39, 10)
    expect(entry!.current_year_depreciation).toBe(1000)
  })

  it('floors ending_adjusted_basis at 0 even if prior cumulative plus current exceeds cost basis', () => {
    const asset = { ...baseAsset, purchase_price: 1000 }
    // Contrived: priorCumulative already exceeds cost basis (e.g. a manual correction upstream).
    const entry = calculateAnnualDepreciation(asset, 2020, 1500)
    expect(entry!.ending_adjusted_basis).toBe(0)
  })

  it('rounds current_year_depreciation to the nearest cent', () => {
    const asset = { ...baseAsset, purchase_price: 9999.99 }
    const entry = calculateAnnualDepreciation(asset, 2020, 0)
    // 9999.99 * 0.20 = 1999.998 -> rounds to 2000.00
    expect(entry!.current_year_depreciation).toBe(2000)
  })

  it('generates a unique id and an ISO generated_at timestamp', () => {
    const entry1 = calculateAnnualDepreciation(baseAsset, 2020, 0)
    const entry2 = calculateAnnualDepreciation(baseAsset, 2020, 0)
    expect(entry1!.id).not.toBe(entry2!.id)
    expect(() => new Date(entry1!.generated_at).toISOString()).not.toThrow()
  })
})

describe('MACRS_LABELS', () => {
  it('has a human-readable label for every MacrsClass', () => {
    expect(MACRS_LABELS['5_year']).toBe('5-Year MACRS')
    expect(MACRS_LABELS['15_year']).toBe('15-Year MACRS')
    expect(MACRS_LABELS['27_5_year']).toBe('27.5-Year Straight-Line')
    expect(MACRS_LABELS['39_year']).toBe('39-Year Straight-Line')
    expect(MACRS_LABELS['section_179']).toBe('Section 179')
  })
})
