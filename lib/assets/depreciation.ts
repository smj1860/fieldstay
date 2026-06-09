import type { PropertyAsset, MacrsClass, AssetDepreciationEntry } from '@/types/database'

// IRS Publication 946 — half-year convention
// Table A-1 (200% DB) for 5-year, Table A-1 (150% DB) for 15-year
const MACRS_RATES: Record<MacrsClass, number[]> = {
  '5_year':  [0.2000, 0.3200, 0.1920, 0.1152, 0.1152, 0.0576],
  '15_year': [0.0500, 0.0950, 0.0855, 0.0770, 0.0693, 0.0623,
              0.0590, 0.0590, 0.0590, 0.0590, 0.0590, 0.0590,
              0.0590, 0.0590, 0.0590, 0.0295],
  '27_5_year':   [],   // straight-line: 1/27.5 per year
  '39_year':     [],   // straight-line: 1/39 per year
  'section_179': [],   // 100% year 1
}

export function getMacrsRate(macrsClass: MacrsClass, yearOfService: number): number {
  if (macrsClass === 'section_179') return yearOfService === 1 ? 1.0 : 0
  if (macrsClass === '27_5_year')   return 1 / 27.5
  if (macrsClass === '39_year')     return 1 / 39

  const rates = MACRS_RATES[macrsClass]
  if (yearOfService < 1) return 0
  // Final year: return whatever is needed to reach exactly 100% cost recovery
  if (yearOfService === rates.length) {
    const priorSum = rates.slice(0, -1).reduce((s, r) => s + r, 0)
    return Math.max(0, 1 - priorSum)
  }
  if (yearOfService > rates.length) return 0
  return rates[yearOfService - 1]!
}

export function calculateAnnualDepreciation(
  asset:           Pick<PropertyAsset, 'id' | 'org_id' | 'placed_in_service_date' | 'purchase_price' | 'salvage_value' | 'macrs_class'>,
  taxYear:         number,
  priorCumulative: number,
): AssetDepreciationEntry | null {
  if (!asset.placed_in_service_date || !asset.purchase_price) return null

  const serviceYear   = new Date(asset.placed_in_service_date).getFullYear()
  const yearOfService = taxYear - serviceYear + 1

  if (yearOfService < 1) return null

  const rate        = getMacrsRate(asset.macrs_class, yearOfService)
  const costBasis   = asset.purchase_price - (asset.salvage_value ?? 0)
  const currentDepr = Math.round(costBasis * rate * 100) / 100
  const endingBasis = Math.max(0, costBasis - priorCumulative - currentDepr)

  return {
    id:                            crypto.randomUUID(),
    org_id:                        asset.org_id,
    asset_id:                      asset.id,
    tax_year:                      taxYear,
    macrs_class:                   asset.macrs_class,
    cost_basis:                    costBasis,
    prior_cumulative_depreciation: priorCumulative,
    current_year_depreciation:     currentDepr,
    ending_adjusted_basis:         endingBasis,
    depreciation_rate:             rate,
    notes:                         null,
    generated_at:                  new Date().toISOString(),
  }
}

export const MACRS_LABELS: Record<MacrsClass, string> = {
  '5_year':      '5-Year MACRS',
  '15_year':     '15-Year MACRS',
  '27_5_year':   '27.5-Year Straight-Line',
  '39_year':     '39-Year Straight-Line',
  'section_179': 'Section 179',
}
