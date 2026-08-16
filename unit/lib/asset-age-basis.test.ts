import { describe, it, expect } from 'vitest'

// ============================================================================
// Which date an asset's age and depreciation are measured from.
//
// THE DEFECT: property_assets.manufacture_date was WRITE-ONLY. The data-plate
// scan reads a manufacture year off the photo and stores it; nothing read it
// back. So a scanned appliance scored a flat 50 forever, was filtered out of
// the capex projection, was excluded from the Weibull lifespan fit, and
// generated no depreciation — while FieldStay held a real year for it.
//
// Manufacture year is not an installation date, so it is LAST in the
// precedence and always carries `estimated: true` for the caller to mark.
// ============================================================================

import {
  assetAgeBasis,
  assetServiceBasis,
  assetAgeYears,
  formatBasisDate,
  ESTIMATED_DATE_MARKER,
} from '@/lib/assets/age-basis'

const NONE = { installation_date: null, manufacture_date: null, placed_in_service_date: null }

describe('assetAgeBasis', () => {
  it('prefers a recorded installation date', () => {
    expect(assetAgeBasis({ installation_date: '2019-06-01', manufacture_date: '2015-01-01' }))
      .toEqual({ date: '2019-06-01', source: 'installation', estimated: false })
  })

  it('falls back to the nameplate manufacture year, flagged as estimated', () => {
    expect(assetAgeBasis({ installation_date: null, manufacture_date: '2015-01-01' }))
      .toEqual({ date: '2015-01-01', source: 'manufacture', estimated: true })
  })

  it('is null when the asset carries no date at all', () => {
    expect(assetAgeBasis({ installation_date: null, manufacture_date: null })).toBeNull()
  })

  it('IGNORES placed_in_service_date — that is a tax election, not a physical age', () => {
    // A PM can place a unit in service in a different year from the one it was
    // installed. Depreciating from that date says nothing about how worn the
    // compressor is, so age scoring must not read it.
    const asset = { installation_date: null, manufacture_date: null, placed_in_service_date: '2021-01-01' }
    expect(assetAgeBasis(asset)).toBeNull()
  })
})

describe('assetServiceBasis', () => {
  it('prefers the deliberately-set placed_in_service_date over both physical dates', () => {
    expect(assetServiceBasis({
      placed_in_service_date: '2021-01-01',
      installation_date:      '2019-06-01',
      manufacture_date:       '2015-01-01',
    })).toEqual({ date: '2021-01-01', source: 'placed_in_service', estimated: false })
  })

  it('falls back to the installation date, then to the nameplate year', () => {
    expect(assetServiceBasis({ ...NONE, installation_date: '2019-06-01' }))
      .toEqual({ date: '2019-06-01', source: 'installation', estimated: false })

    expect(assetServiceBasis({ ...NONE, manufacture_date: '2015-01-01' }))
      .toEqual({ date: '2015-01-01', source: 'manufacture', estimated: true })
  })

  it('marks ONLY the manufacture fallback as estimated', () => {
    // The flag is what every caller uses to label the inference. A recorded
    // date that came out of the fallback chain is still a recorded date.
    for (const asset of [
      { ...NONE, placed_in_service_date: '2021-01-01' },
      { ...NONE, installation_date: '2019-06-01' },
    ]) {
      expect(assetServiceBasis(asset)?.estimated).toBe(false)
    }
  })
})

describe('assetAgeYears', () => {
  const now = new Date('2026-08-16T00:00:00Z')

  it('counts whole years from the resolved basis', () => {
    expect(assetAgeYears({ installation_date: '2019-06-01', manufacture_date: null }, now)).toBe(7)
    expect(assetAgeYears({ installation_date: null, manufacture_date: '2015-01-01' }, now)).toBe(11)
  })

  it('floors at 0 rather than reporting a negative age', () => {
    // A nameplate year can read ahead of the current year — model-year dating,
    // or an OCR misread. A negative age would invert the Weibull curve.
    expect(assetAgeYears({ installation_date: '2030-01-01', manufacture_date: null }, now)).toBe(0)
  })

  it('is null for an undated asset', () => {
    expect(assetAgeYears({ installation_date: null, manufacture_date: null }, now)).toBeNull()
  })
})

describe('formatBasisDate', () => {
  it('marks an estimated date and leaves a recorded one clean', () => {
    expect(formatBasisDate({ date: '2015-01-01', source: 'manufacture', estimated: true }))
      .toBe(`2015-01-01${ESTIMATED_DATE_MARKER}`)
    expect(formatBasisDate({ date: '2019-06-01', source: 'installation', estimated: false }))
      .toBe('2019-06-01')
  })

  it('returns the placeholder for an undated asset', () => {
    expect(formatBasisDate(null)).toBe('—')
    expect(formatBasisDate(null, 'n/a')).toBe('n/a')
  })
})
