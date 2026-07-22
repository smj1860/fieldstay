import { describe, it, expect } from 'vitest'
import type { AssetType } from '@/types/database'
import {
  REQUIRED_ASSET_TYPES,
  ASSET_TYPE_DISPLAY_NAMES,
  ASSET_DISCOVERY_SECTION,
  assetTypeDisplayName,
  discoveryTaskLabel,
  categoryForAssetType,
  missingAssetTypesFromDiscoveredSet,
} from '@/lib/asset-discovery/config'

describe('REQUIRED_ASSET_TYPES', () => {
  it('contains no duplicate asset types', () => {
    expect(new Set(REQUIRED_ASSET_TYPES).size).toBe(REQUIRED_ASSET_TYPES.length)
  })

  it('is non-empty', () => {
    expect(REQUIRED_ASSET_TYPES.length).toBeGreaterThan(0)
  })

  it('has a display name entry for every required asset type', () => {
    for (const t of REQUIRED_ASSET_TYPES) {
      expect(ASSET_TYPE_DISPLAY_NAMES[t]).toBeDefined()
    }
  })
})

describe('assetTypeDisplayName', () => {
  it('returns the human-readable display name for a known asset type', () => {
    expect(assetTypeDisplayName('hvac')).toBe('HVAC')
    expect(assetTypeDisplayName('water_heater')).toBe('Water Heater')
  })

  it('falls back to the raw asset type string for a type with no display name entry', () => {
    // 'roof' is a valid AssetType but not in REQUIRED_ASSET_TYPES / the
    // display-name map (asset discovery doesn't prompt for it).
    expect(assetTypeDisplayName('roof' as AssetType)).toBe('roof')
  })
})

describe('discoveryTaskLabel', () => {
  it('formats the checklist task label with the display name', () => {
    expect(discoveryTaskLabel('hvac')).toBe('Capture asset details: HVAC')
  })

  it('falls back to the raw type when no display name is registered', () => {
    expect(discoveryTaskLabel('garage_door' as AssetType)).toBe('Capture asset details: garage_door')
  })
})

describe('ASSET_DISCOVERY_SECTION', () => {
  it('is the fixed checklist section name', () => {
    expect(ASSET_DISCOVERY_SECTION).toBe('Asset Discovery')
  })
})

describe('categoryForAssetType', () => {
  it('maps hvac and thermostat to the hvac work order category', () => {
    expect(categoryForAssetType('hvac')).toBe('hvac')
    expect(categoryForAssetType('thermostat')).toBe('hvac')
  })

  it('maps water-related asset types to plumbing', () => {
    expect(categoryForAssetType('water_heater')).toBe('plumbing')
    expect(categoryForAssetType('plumbing_system')).toBe('plumbing')
    expect(categoryForAssetType('septic_system')).toBe('plumbing')
    expect(categoryForAssetType('well_pump')).toBe('plumbing')
    expect(categoryForAssetType('water_shutoff_valve')).toBe('plumbing')
    expect(categoryForAssetType('whole_home_water_filter')).toBe('plumbing')
  })

  it('maps kitchen/laundry appliances to appliance', () => {
    expect(categoryForAssetType('refrigerator')).toBe('appliance')
    expect(categoryForAssetType('washer')).toBe('appliance')
    expect(categoryForAssetType('dryer')).toBe('appliance')
    expect(categoryForAssetType('dishwasher')).toBe('appliance')
    expect(categoryForAssetType('microwave')).toBe('appliance')
    expect(categoryForAssetType('oven_range')).toBe('appliance')
  })

  it('maps pool_pump and hot_tub to pool', () => {
    expect(categoryForAssetType('pool_pump')).toBe('pool')
    expect(categoryForAssetType('hot_tub')).toBe('pool')
  })

  it('maps electrical-adjacent asset types to electrical', () => {
    expect(categoryForAssetType('electrical_panel')).toBe('electrical')
    expect(categoryForAssetType('generator')).toBe('electrical')
    expect(categoryForAssetType('solar_system')).toBe('electrical')
    expect(categoryForAssetType('solar_inverter')).toBe('electrical')
    expect(categoryForAssetType('heated_tile_system')).toBe('electrical')
  })

  it('maps roof to roofing and deck_structure to structural', () => {
    expect(categoryForAssetType('roof')).toBe('roofing')
    expect(categoryForAssetType('deck_structure')).toBe('structural')
  })

  it('falls back to general for a null asset type', () => {
    expect(categoryForAssetType(null)).toBe('general')
  })

  it('falls back to general for an asset type with no explicit mapping', () => {
    expect(categoryForAssetType('smart_lock')).toBe('general')
    expect(categoryForAssetType('other')).toBe('general')
  })
})

describe('missingAssetTypesFromDiscoveredSet', () => {
  it('returns every required type when the discovered set is empty', () => {
    expect(missingAssetTypesFromDiscoveredSet(new Set())).toEqual(REQUIRED_ASSET_TYPES)
  })

  it('excludes discovered types from the result', () => {
    const discovered = new Set<AssetType>(['hvac', 'water_heater'])
    const missing = missingAssetTypesFromDiscoveredSet(discovered)

    expect(missing).not.toContain('hvac')
    expect(missing).not.toContain('water_heater')
    expect(missing.length).toBe(REQUIRED_ASSET_TYPES.length - 2)
  })

  it('returns an empty array when every required type has been discovered', () => {
    expect(missingAssetTypesFromDiscoveredSet(new Set(REQUIRED_ASSET_TYPES))).toEqual([])
  })

  it('ignores discovered types that are not in REQUIRED_ASSET_TYPES at all', () => {
    const discovered = new Set<AssetType>(['garage_door']) // valid AssetType, not required
    expect(missingAssetTypesFromDiscoveredSet(discovered)).toEqual(REQUIRED_ASSET_TYPES)
  })

  it('preserves REQUIRED_ASSET_TYPES ordering in the result', () => {
    const missing = missingAssetTypesFromDiscoveredSet(new Set(['dryer' as AssetType]))
    const expectedOrder = REQUIRED_ASSET_TYPES.filter((t) => t !== 'dryer')
    expect(missing).toEqual(expectedOrder)
  })
})
