import { describe, it, expect } from 'vitest'
import type { AssetType } from '@/types/database'
import {
  normalizeAssetType,
  parseCsvLine,
  parseAssetCsvText,
} from '@/lib/csv/parseAssetCsv'

// Mirrors the ASSET_TYPES list asset-manager.tsx passes in as the source of
// truth (see parseAssetCsv.ts's comment on normalizeAssetType).
const KNOWN_TYPES: AssetType[] = [
  'hvac', 'water_heater', 'roof', 'refrigerator', 'washer',
  'dryer', 'dishwasher', 'microwave', 'oven_range', 'pool_pump',
  'hot_tub', 'garage_door', 'smart_lock', 'deck_structure',
  'electrical_panel', 'plumbing_system', 'septic_system', 'well_pump',
  'generator', 'solar_system', 'other',
  'water_shutoff_valve', 'solar_inverter', 'whole_home_water_filter',
  'heated_tile_system', 'range_hood_vent', 'coffee_station',
  'toaster_oven', 'wifi_router', 'fire_extinguisher', 'thermostat',
  'ice_maker', 'garbage_disposal', 'trash_compactor',
]

describe('normalizeAssetType', () => {
  it('resolves a known alias case-insensitively', () => {
    expect(normalizeAssetType('Water Heater', KNOWN_TYPES)).toBe('water_heater')
    expect(normalizeAssetType('HOT TUB', KNOWN_TYPES)).toBe('hot_tub')
    expect(normalizeAssetType('fridge', KNOWN_TYPES)).toBe('refrigerator')
  })

  it('resolves an alias regardless of surrounding whitespace', () => {
    expect(normalizeAssetType('  spa  ', KNOWN_TYPES)).toBe('hot_tub')
  })

  it('normalizes underscores to spaces before alias lookup', () => {
    expect(normalizeAssetType('pool_pump', KNOWN_TYPES)).toBe('pool_pump')
    expect(normalizeAssetType('garage_door', KNOWN_TYPES)).toBe('garage_door')
  })

  it('falls back to a direct enum-value match when no alias exists', () => {
    expect(normalizeAssetType('thermostat', KNOWN_TYPES)).toBe('thermostat')
    expect(normalizeAssetType('Smart Lock', KNOWN_TYPES)).toBe('smart_lock')
  })

  it('returns null for a value with no alias and no enum match', () => {
    expect(normalizeAssetType('space heater', KNOWN_TYPES)).toBeNull()
    expect(normalizeAssetType('', KNOWN_TYPES)).toBeNull()
  })

  it('is not fooled by an alias whose resolved value is outside knownTypes', () => {
    // 'other' alias resolves to a value that IS in KNOWN_TYPES, but if a
    // caller passes a knownTypes list missing it, the alias table itself
    // still wins over the (failing) knownTypes.includes fallback.
    expect(normalizeAssetType('other', ['hvac'])).toBe('other')
  })
})

describe('parseCsvLine', () => {
  it('splits a simple comma-separated line', () => {
    expect(parseCsvLine('HVAC Unit,hvac,Trane,XR16')).toEqual(['HVAC Unit', 'hvac', 'Trane', 'XR16'])
  })

  it('keeps a comma inside a quoted field intact', () => {
    expect(parseCsvLine('Water Heater,water_heater,,,"Replaced 3,500 sq ft of ductwork"')).toEqual([
      'Water Heater', 'water_heater', '', '', 'Replaced 3,500 sq ft of ductwork',
    ])
  })

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvLine('Roof,roof,,,"Guest said ""leaking again"""')).toEqual([
      'Roof', 'roof', '', '', 'Guest said "leaking again"',
    ])
  })

  it('trims whitespace around each cell', () => {
    expect(parseCsvLine('  HVAC Unit  , hvac ,  Trane  ')).toEqual(['HVAC Unit', 'hvac', 'Trane'])
  })

  it('produces one empty cell for an empty line', () => {
    expect(parseCsvLine('')).toEqual([''])
  })

  it('handles a trailing empty cell after a trailing comma', () => {
    expect(parseCsvLine('HVAC Unit,hvac,')).toEqual(['HVAC Unit', 'hvac', ''])
  })
})

describe('parseAssetCsvText', () => {
  const HEADER = 'name,asset_type,make,model,serial_number,installation_date,purchase_price,estimated_replacement_cost,warranty_expiry_date,warranty_provider,notes'

  it('parses a well-formed multi-row CSV', () => {
    const csv = [
      HEADER,
      'Main HVAC,hvac,Trane,XR16,SN-001,2022-05-01,5200,6000,2027-05-01,Trane Home,Installed by ACME',
      'Roof,roof,,,,,,,,,',
    ].join('\n')

    const result = parseAssetCsvText(csv, KNOWN_TYPES)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rows).toHaveLength(2)

    const [hvacRow, roofRow] = result.rows
    expect(hvacRow).toMatchObject({
      name: 'Main HVAC', asset_type: 'hvac', make: 'Trane', model: 'XR16',
      serial_number: 'SN-001', installation_date: '2022-05-01',
      purchase_price: 5200, estimated_replacement_cost: 6000,
      warranty_expiry_date: '2027-05-01', warranty_provider: 'Trane Home',
      notes: 'Installed by ACME', _valid: true, _typeResolved: 'hvac', _raw_type: 'hvac',
    })
    expect(roofRow).toMatchObject({
      name: 'Roof', asset_type: 'roof', make: null, model: null,
      serial_number: null, installation_date: null, purchase_price: null,
      estimated_replacement_cost: null, warranty_expiry_date: null,
      warranty_provider: null, notes: null, _valid: true,
    })
  })

  it('flags a row with an unrecognized asset_type as invalid but still returns it', () => {
    const csv = [HEADER, 'Space Heater,space heater,,,,,,,,,'].join('\n')

    const result = parseAssetCsvText(csv, KNOWN_TYPES)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rows[0]).toMatchObject({
      name: 'Space Heater', asset_type: 'space heater', _valid: false,
      _typeResolved: null, _raw_type: 'space heater',
    })
  })

  it('flags a row missing a name as invalid', () => {
    const csv = [HEADER, ',hvac,,,,,,,,,'].join('\n')

    const result = parseAssetCsvText(csv, KNOWN_TYPES)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rows[0]?._valid).toBe(false)
  })

  it('treats a missing asset_type column in the header as an unresolved type for every row', () => {
    const csv = ['name,make', 'Main HVAC,Trane'].join('\n')

    const result = parseAssetCsvText(csv, KNOWN_TYPES)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rows[0]).toMatchObject({ name: 'Main HVAC', asset_type: '', _valid: false, _typeResolved: null })
  })

  it('treats a row shorter than the header as having blank trailing fields, not a thrown error', () => {
    const csv = [HEADER, 'Main HVAC,hvac'].join('\n')

    const result = parseAssetCsvText(csv, KNOWN_TYPES)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rows[0]).toMatchObject({
      name: 'Main HVAC', asset_type: 'hvac', make: null, model: null,
      purchase_price: null, _valid: true,
    })
  })

  it('parses numeric fields even with surrounding whitespace/quoting', () => {
    const csv = [HEADER, '"Main HVAC",hvac,,,,, " 5200.50" , 6000 ,,,'].join('\n')

    const result = parseAssetCsvText(csv, KNOWN_TYPES)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rows[0]?.purchase_price).toBeCloseTo(5200.5)
    expect(result.rows[0]?.estimated_replacement_cost).toBe(6000)
  })

  it('rejects an empty file', () => {
    const result = parseAssetCsvText('', KNOWN_TYPES)

    expect(result).toEqual({ ok: false, rows: null, error: 'CSV must have a header row and at least one data row.' })
  })

  it('rejects a file with only a header row', () => {
    const result = parseAssetCsvText(HEADER, KNOWN_TYPES)

    expect(result).toEqual({ ok: false, rows: null, error: 'CSV must have a header row and at least one data row.' })
  })

  it('rejects a file made up only of blank lines', () => {
    const result = parseAssetCsvText('\n\n   \n', KNOWN_TYPES)

    expect(result).toEqual({ ok: false, rows: null, error: 'CSV must have a header row and at least one data row.' })
  })

  it('is tolerant of \\r\\n line endings and blank lines between rows', () => {
    const csv = [HEADER, 'Main HVAC,hvac,,,,,,,,,', '', 'Roof,roof,,,,,,,,,'].join('\r\n')

    const result = parseAssetCsvText(csv, KNOWN_TYPES)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rows).toHaveLength(2)
  })

  it('matches header names case-insensitively', () => {
    const csv = ['NAME,ASSET_TYPE', 'Main HVAC,hvac'].join('\n')

    const result = parseAssetCsvText(csv, KNOWN_TYPES)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rows[0]).toMatchObject({ name: 'Main HVAC', asset_type: 'hvac', _valid: true })
  })
})
