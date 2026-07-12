import type { AssetType } from '@/types/database'

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

export const ASSET_DISCOVERY_SECTION = 'Asset Discovery'

export function assetTypeDisplayName(assetType: AssetType): string {
  return ASSET_TYPE_DISPLAY_NAMES[assetType] ?? assetType
}

export function discoveryTaskLabel(assetType: AssetType): string {
  return `Capture asset details: ${assetTypeDisplayName(assetType)}`
}
