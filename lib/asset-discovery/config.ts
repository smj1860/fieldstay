import type { AssetType, CrewLocale, WoCategory } from '@/types/database'

/**
 * Master Asset List for Progressive Asset Discovery. Crews are prompted to
 * capture/verify each of these once per property. Types that already exist
 * on the asset_type enum (hvac, refrigerator, etc.) are reused directly —
 * a property with an existing Asset Health record (make/model populated)
 * for one of those is already considered discovered.
 */
export const REQUIRED_ASSET_TYPES: AssetType[] = [
  // Utilities & mechanical
  'hvac', 'water_heater', 'electrical_panel', 'water_shutoff_valve',
  'well_pump', 'solar_inverter', 'whole_home_water_filter', 'generator',
  // Luxury & amenities
  'pool_pump', 'hot_tub', 'heated_tile_system',
  // Kitchen & appliances
  'refrigerator', 'oven_range', 'dishwasher', 'microwave',
  'range_hood_vent', 'coffee_station', 'toaster_oven',
  'ice_maker', 'garbage_disposal', 'trash_compactor',
  // Laundry & operational / smart home
  'washer', 'dryer', 'wifi_router', 'smart_lock', 'fire_extinguisher',
  'thermostat',
]

/**
 * One source of truth per asset type — {en, es} together, rather than two
 * structurally-identical dictionaries — so a static-analysis duplicate-code
 * detector (which tokenizes shape, not string content) doesn't see two
 * copy-pasted blocks. `es` is used only by the crew app's UI (locale is a
 * crew_members preference, never a dashboard concept); every other caller
 * (the PM dashboard, the server-side discovery engine) keeps getting
 * English via assetTypeDisplayName()'s default, unaffected by this.
 */
const ASSET_TYPE_NAMES: Partial<Record<AssetType, { en: string; es: string }>> = {
  hvac:                     { en: 'HVAC',                        es: 'Aire acondicionado (HVAC)' },
  water_heater:             { en: 'Water Heater',                es: 'Calentador de agua' },
  electrical_panel:         { en: 'Electrical Panel',            es: 'Panel eléctrico' },
  water_shutoff_valve:      { en: 'Water Shut-off Valve',        es: 'Válvula de cierre de agua' },
  well_pump:                { en: 'Well Pump & Bladder Tank',    es: 'Bomba de pozo y tanque de presión' },
  solar_inverter:           { en: 'Solar Inverter',              es: 'Inversor solar' },
  whole_home_water_filter:  { en: 'Whole Home Water Filter',     es: 'Filtro de agua de toda la casa' },
  generator:                { en: 'Generator',                   es: 'Generador' },
  pool_pump:                { en: 'Pool Pump',                   es: 'Bomba de la piscina' },
  hot_tub:                  { en: 'Hot Tub Equipment',           es: 'Equipo del jacuzzi' },
  heated_tile_system:       { en: 'Heated Tile System',          es: 'Sistema de piso radiante' },
  refrigerator:             { en: 'Refrigerator',                es: 'Refrigerador' },
  oven_range:               { en: 'Stove & Oven',                es: 'Estufa y horno' },
  dishwasher:               { en: 'Dishwasher',                  es: 'Lavavajillas' },
  microwave:                { en: 'Microwave',                   es: 'Microondas' },
  range_hood_vent:          { en: 'Range Hood Vent',             es: 'Campana extractora' },
  coffee_station:           { en: 'Coffee & Nespresso Station',  es: 'Estación de café y Nespresso' },
  toaster_oven:             { en: 'Countertop Toaster Oven',     es: 'Horno tostador de mostrador' },
  ice_maker:                { en: 'Ice Maker',                   es: 'Máquina de hielo' },
  garbage_disposal:         { en: 'Garbage Disposal',            es: 'Triturador de basura' },
  trash_compactor:          { en: 'Trash Compactor',             es: 'Compactador de basura' },
  washer:                   { en: 'Washer',                      es: 'Lavadora' },
  dryer:                    { en: 'Dryer',                       es: 'Secadora' },
  wifi_router:              { en: 'Wi-Fi Router',                es: 'Router Wi-Fi' },
  smart_lock:               { en: 'Smart Lock',                  es: 'Cerradura inteligente' },
  fire_extinguisher:        { en: 'Fire Extinguisher',           es: 'Extintor' },
  thermostat:               { en: 'Thermostat',                  es: 'Termostato' },
}

function pluckAssetNames(locale: 'en' | 'es'): Partial<Record<AssetType, string>> {
  return Object.fromEntries(
    Object.entries(ASSET_TYPE_NAMES).map(([type, names]) => [type, names[locale]])
  ) as Partial<Record<AssetType, string>>
}

export const ASSET_TYPE_DISPLAY_NAMES: Partial<Record<AssetType, string>> = pluckAssetNames('en')
export const ASSET_TYPE_DISPLAY_NAMES_ES: Partial<Record<AssetType, string>> = pluckAssetNames('es')

export const ASSET_DISCOVERY_SECTION = 'Asset Discovery'
/**
 * Spanish sibling of ASSET_DISCOVERY_SECTION — stored as
 * checklist_instance_items.section_name_es on every system-mandated asset
 * discovery item, independent of the viewer's own locale (a turnover can be
 * worked by crew in either language).
 */
export const ASSET_DISCOVERY_SECTION_ES = 'Inventario de bienes'

export function assetTypeDisplayName(assetType: AssetType, locale: CrewLocale = 'en'): string {
  if (locale === 'es') return ASSET_TYPE_DISPLAY_NAMES_ES[assetType] ?? ASSET_TYPE_DISPLAY_NAMES[assetType] ?? assetType
  return ASSET_TYPE_DISPLAY_NAMES[assetType] ?? assetType
}

export function discoveryTaskLabel(assetType: AssetType): string {
  return `Capture asset details: ${assetTypeDisplayName(assetType)}`
}

/** Spanish sibling of discoveryTaskLabel — stored as task_es. */
export function discoveryTaskLabelEs(assetType: AssetType): string {
  return `Capturar detalles del bien: ${assetTypeDisplayName(assetType, 'es')}`
}

/**
 * Auto-derives a work order category from the asset a crew member selects
 * when placing a work order from the Assets & Maintenance page — crew never
 * pick a category themselves. Types not listed here (and "Other"/no asset)
 * fall back to 'general'.
 */
const ASSET_TYPE_TO_WO_CATEGORY: Partial<Record<AssetType, WoCategory>> = {
  hvac:                     'hvac',
  thermostat:               'hvac',
  water_heater:             'plumbing',
  plumbing_system:          'plumbing',
  septic_system:            'plumbing',
  well_pump:                'plumbing',
  water_shutoff_valve:      'plumbing',
  whole_home_water_filter:  'plumbing',
  roof:                     'roofing',
  refrigerator:             'appliance',
  washer:                   'appliance',
  dryer:                    'appliance',
  dishwasher:               'appliance',
  microwave:                'appliance',
  oven_range:               'appliance',
  range_hood_vent:          'appliance',
  coffee_station:           'appliance',
  toaster_oven:             'appliance',
  ice_maker:                'appliance',
  garbage_disposal:         'appliance',
  trash_compactor:          'appliance',
  pool_pump:                'pool',
  hot_tub:                  'pool',
  electrical_panel:         'electrical',
  generator:                'electrical',
  solar_system:             'electrical',
  solar_inverter:           'electrical',
  heated_tile_system:       'electrical',
  deck_structure:           'structural',
}

export function categoryForAssetType(assetType: AssetType | null): WoCategory {
  if (!assetType) return 'general'
  return ASSET_TYPE_TO_WO_CATEGORY[assetType] ?? 'general'
}

/**
 * REQUIRED_ASSET_TYPES not yet present in a discovered-types set. Callers
 * build that set themselves (server and Dexie rows use different null
 * conventions for make/model/photo_url/is_na) and pass it in here so the
 * "which types are still missing" logic itself isn't duplicated at every
 * call site (PM Assets page, crew Assets page, turnover soft-enforcement
 * checks, the completion Inngest step).
 */
export function missingAssetTypesFromDiscoveredSet(discoveredTypes: Set<AssetType>): AssetType[] {
  return REQUIRED_ASSET_TYPES.filter((t) => !discoveredTypes.has(t))
}
