import type { AssetType } from '@/types/database'
import type { CsvAssetRow } from '@/app/(dashboard)/properties/actions'

/**
 * CSV parsing + asset-type resolution for the property assets bulk-import
 * flow — extracted out of app/(dashboard)/assets/asset-manager.tsx's
 * CsvImportModal, which used to embed this lexer/state-machine and
 * row-normalization logic directly beside its results-table rendering.
 */

export interface ParsedAssetCsvRow extends CsvAssetRow {
  _valid:        boolean
  _typeResolved: AssetType | null
  _raw_type:     string
}

const ASSET_TYPE_ALIASES: Record<string, AssetType> = {
  'hvac':            'hvac',
  'water heater':    'water_heater',
  'waterheater':     'water_heater',
  'roof':            'roof',
  'refrigerator':    'refrigerator',
  'fridge':          'refrigerator',
  'washer':          'washer',
  'dryer':           'dryer',
  'dishwasher':      'dishwasher',
  'microwave':       'microwave',
  'oven':            'oven_range',
  'range':           'oven_range',
  'oven range':      'oven_range',
  'pool pump':       'pool_pump',
  'pool':            'pool_pump',
  'hot tub':         'hot_tub',
  'hottub':          'hot_tub',
  'spa':             'hot_tub',
  'garage door':     'garage_door',
  'garagedoor':      'garage_door',
  'smart lock':      'smart_lock',
  'smartlock':       'smart_lock',
  'lock':            'smart_lock',
  'deck':            'deck_structure',
  'deck structure':  'deck_structure',
  'electrical panel':'electrical_panel',
  'panel':           'electrical_panel',
  'plumbing':        'plumbing_system',
  'septic':          'septic_system',
  'well pump':       'well_pump',
  'wellpump':        'well_pump',
  'generator':       'generator',
  'solar':           'solar_system',
  'solar system':    'solar_system',
  'ice maker':       'ice_maker',
  'icemaker':        'ice_maker',
  'garbage disposal':'garbage_disposal',
  'disposal':        'garbage_disposal',
  'trash compactor': 'trash_compactor',
  'compactor':       'trash_compactor',
  'water shutoff valve': 'water_shutoff_valve',
  'water shutoff':       'water_shutoff_valve',
  'shutoff valve':       'water_shutoff_valve',
  'solar inverter':      'solar_inverter',
  'inverter':            'solar_inverter',
  'whole home water filter': 'whole_home_water_filter',
  'water filter':            'whole_home_water_filter',
  'heated tile system': 'heated_tile_system',
  'heated tile':        'heated_tile_system',
  'radiant floor':      'heated_tile_system',
  'range hood vent': 'range_hood_vent',
  'range hood':      'range_hood_vent',
  'hood vent':       'range_hood_vent',
  'coffee station': 'coffee_station',
  'coffee maker':   'coffee_station',
  'nespresso':      'coffee_station',
  'toaster oven': 'toaster_oven',
  'toaster':      'toaster_oven',
  'wifi router': 'wifi_router',
  'wifi':        'wifi_router',
  'router':      'wifi_router',
  'fire extinguisher': 'fire_extinguisher',
  'extinguisher':      'fire_extinguisher',
  'thermostat': 'thermostat',
  'other':           'other',
}

/**
 * `knownTypes` is the caller's own ASSET_TYPES list (asset-manager.tsx is
 * the source of truth for that enum-value list, since it also drives UI
 * dropdowns) — passed in rather than duplicated here so there's exactly
 * one list to keep in sync when a new asset type is added.
 */
export function normalizeAssetType(raw: string, knownTypes: readonly AssetType[]): AssetType | null {
  const lower = raw.toLowerCase().trim().replace(/_/g, ' ')
  if (ASSET_TYPE_ALIASES[lower]) return ASSET_TYPE_ALIASES[lower]
  const asValue = lower.replace(/ /g, '_')
  if (knownTypes.includes(asValue as AssetType)) return asValue as AssetType
  return null
}

// Naive comma-split breaks on any field with a comma inside quotes (most
// likely `notes`, e.g. `"Replaced 3,500 sq ft of ductwork"`). This is a
// minimal state-machine parser — correct for quoted fields and escaped
// ("") quotes, without pulling in a new dependency for one import modal.
export function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current  = ''
  let inQuotes = false

  // One flat branch per state, most specific first — the same state machine
  // as the nested form, without the nesting.
  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    // Escaped quote inside a quoted field: "" is a literal ".
    if (inQuotes && char === '"' && line[i + 1] === '"') { current += '"'; i++; continue }
    // Lone quote inside a quoted field closes it.
    if (inQuotes && char === '"') { inQuotes = false; continue }
    // Any other character inside quotes is literal — commas included.
    if (inQuotes) { current += char; continue }

    if (char === '"') { inQuotes = true; continue }
    if (char === ',') { cells.push(current); current = ''; continue }
    current += char
  }
  cells.push(current)
  return cells.map((c) => c.trim())
}

/** Oldest plausible nameplate year — below this it is a typo, not an appliance. */
const MIN_MANUFACTURE_YEAR = 1900

/**
 * The CSV's `manufacture_year` column as a `YYYY-01-01` date, matching what
 * asset-scan.ts and the asset form both store for the same fact. A year is
 * what a nameplate carries, and a year is what a PM has to hand when bulk-
 * importing from a prior system — install dates usually did not come across.
 *
 * An out-of-range or non-numeric value becomes null rather than an error: one
 * bad cell must not reject a 200-row import, and an asset with no manufacture
 * year is simply an asset the age fallback cannot help.
 */
function manufactureDateFromYear(raw: string): string | null {
  const year = Number(raw.trim())
  const maxYear = new Date().getFullYear() + 1
  if (!raw.trim() || !Number.isInteger(year) || year < MIN_MANUFACTURE_YEAR || year > maxYear) {
    return null
  }
  return `${year}-01-01`
}

export type ParseAssetCsvResult =
  | { ok: true; rows: ParsedAssetCsvRow[]; error: null }
  | { ok: false; rows: null; error: string }

/** Parses a full asset-import CSV's text content into normalized rows. */
export function parseAssetCsvText(text: string, knownTypes: readonly AssetType[]): ParseAssetCsvResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) {
    return { ok: false, rows: null, error: 'CSV must have a header row and at least one data row.' }
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
  const rows: ParsedAssetCsvRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i])
    const get   = (key: string) => cells[header.indexOf(key)] ?? ''

    const rawType    = get('asset_type')
    const resolved   = normalizeAssetType(rawType, knownTypes)
    const name       = get('name').trim()

    rows.push({
      name,
      asset_type:                 resolved ?? rawType,
      make:                       get('make') || null,
      model:                      get('model') || null,
      serial_number:              get('serial_number') || null,
      installation_date:          get('installation_date') || null,
      manufacture_date:           manufactureDateFromYear(get('manufacture_year')),
      purchase_price:             get('purchase_price') ? Number.parseFloat(get('purchase_price')) : null,
      estimated_replacement_cost: get('estimated_replacement_cost') ? Number.parseFloat(get('estimated_replacement_cost')) : null,
      warranty_expiry_date:       get('warranty_expiry_date') || null,
      warranty_provider:          get('warranty_provider') || null,
      notes:                      get('notes') || null,
      _valid:                     Boolean(name && resolved),
      _typeResolved:              resolved,
      _raw_type:                  rawType,
    })
  }

  return { ok: true, rows, error: null }
}
