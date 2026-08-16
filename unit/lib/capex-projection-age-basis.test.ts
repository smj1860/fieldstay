import { describe, it, expect } from 'vitest'

// ============================================================================
// The capex plan must include an asset dated only by its nameplate.
//
// THE DEFECT: buildProjections started with `if (!asset.installation_date)
// continue`, and the query feeding it filtered `.not('installation_date','is',
// null)`. Every data-plate-scanned asset was therefore dropped twice over and
// never appeared in a replacement plan — despite FieldStay holding a real
// manufacture year for it. See lib/assets/age-basis.ts.
// ============================================================================

import { buildProjections, type ProjectionAssetRow } from '@/lib/inngest/functions/capex-projection-core'

const CURRENT_YEAR = 2026

const STANDARDS = [{
  asset_type:                'hvac',
  lifespan_min_years:        14,
  lifespan_max_years:        16,
  avg_replacement_cost_low:  6000,
  avg_replacement_cost_high: 9000,
}]

function asset(over: Partial<ProjectionAssetRow>): ProjectionAssetRow {
  return {
    id: 'a1', name: 'Upstairs HVAC', asset_type: 'hvac', property_id: 'p1',
    installation_date: null, manufacture_date: null,
    expected_lifespan_years: 15, estimated_replacement_cost: 8000, health_score: 40,
    ...over,
  }
}

function itemsOf(rows: ProjectionAssetRow[]) {
  const projections = buildProjections(rows, STANDARDS, { p1: 'Lake House' }, CURRENT_YEAR)
  return Object.values(projections).flatMap((y) => y.items)
}

describe('buildProjections — age basis', () => {
  it('projects an asset dated only by its nameplate manufacture year', () => {
    const items = itemsOf([asset({ manufacture_date: '2015-01-01' })])

    expect(items).toHaveLength(1)
    expect(items[0]!.age_years).toBe(11)
    // 15-year lifespan, 11 years old -> 4 years left.
    expect(items[0]!.replacement_year).toBe(2030)
  })

  it('flags that projection as resting on an estimate', () => {
    // A replacement year built on an inference has to be readable as one — the
    // capital-planning page and the CSV export both key off this.
    expect(itemsOf([asset({ manufacture_date: '2015-01-01' })])[0]!.age_estimated).toBe(true)
    expect(itemsOf([asset({ installation_date: '2015-01-01' })])[0]!.age_estimated).toBe(false)
  })

  it('prefers a recorded installation date when both are present', () => {
    const items = itemsOf([asset({ installation_date: '2018-01-01', manufacture_date: '2015-01-01' })])

    expect(items[0]!.age_years).toBe(8)
    expect(items[0]!.age_estimated).toBe(false)
  })

  it('still drops an asset with no date at all', () => {
    // The query filter was loosened to admit either column; the guard here is
    // what keeps an undated asset out of the plan.
    expect(itemsOf([asset({})])).toEqual([])
  })
})
