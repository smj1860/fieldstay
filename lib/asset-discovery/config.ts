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

export const ASSET_TYPE_DISPLAY_NAMES: Partial<Record<AssetType, string>> = {
  hvac:                     'HVAC',
  water_heater:             'Water Heater',
  electrical_panel:         'Electrical Panel',
  water_shutoff_valve:      'Water Shut-off Valve',
  well_pump:                'Well Pump & Bladder Tank',
  solar_inverter:           'Solar Inverter',
  whole_home_water_filter:  'Whole Home Water Filter',
  generator:                'Generator',
  pool_pump:                'Pool Pump',
  hot_tub:                  'Hot Tub Equipment',
  heated_tile_system:       'Heated Tile System',
  refrigerator:             'Refrigerator',
  oven_range:               'Stove & Oven',
  dishwasher:               'Dishwasher',
  microwave:                'Microwave',
  range_hood_vent:          'Range Hood Vent',
  coffee_station:           'Coffee & Nespresso Station',
  toaster_oven:             'Countertop Toaster Oven',
  ice_maker:                'Ice Maker',
  garbage_disposal:         'Garbage Disposal',
  trash_compactor:          'Trash Compactor',
  washer:                   'Washer',
  dryer:                    'Dryer',
  wifi_router:              'Wi-Fi Router',
  smart_lock:               'Smart Lock',
  fire_extinguisher:        'Fire Extinguisher',
  thermostat:               'Thermostat',
}

/**
 * Spanish siblings — used only by the crew app's UI (locale is a crew_members
 * preference, never a dashboard concept). Every other caller (the PM
 * dashboard, the server-side discovery engine) keeps getting English via
 * assetTypeDisplayName()'s default, unaffected by this.
 */
export const ASSET_TYPE_DISPLAY_NAMES_ES: Partial<Record<AssetType, string>> = {
  hvac:                     'Aire acondicionado (HVAC)',
  water_heater:             'Calentador de agua',
  electrical_panel:         'Panel eléctrico',
  water_shutoff_valve:      'Válvula de cierre de agua',
  well_pump:                'Bomba de pozo y tanque de presión',
  solar_inverter:           'Inversor solar',
  whole_home_water_filter:  'Filtro de agua de toda la casa',
  generator:                'Generador',
  pool_pump:                'Bomba de la piscina',
  hot_tub:                  'Equipo del jacuzzi',
  heated_tile_system:       'Sistema de piso radiante',
  refrigerator:             'Refrigerador',
  oven_range:               'Estufa y horno',
  dishwasher:               'Lavavajillas',
  microwave:                'Microondas',
  range_hood_vent:          'Campana extractora',
  coffee_station:           'Estación de café y Nespresso',
  toaster_oven:             'Horno tostador de mostrador',
  ice_maker:                'Máquina de hielo',
  garbage_disposal:         'Triturador de basura',
  trash_compactor:          'Compactador de basura',
  washer:                   'Lavadora',
  dryer:                    'Secadora',
  wifi_router:              'Router Wi-Fi',
  smart_lock:               'Cerradura inteligente',
  fire_extinguisher:        'Extintor',
  thermostat:               'Termostato',
}

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
