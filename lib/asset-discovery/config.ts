import type { AssetType } from '@/types/database'

/**
 * Placeholder discovery types for infrastructure testing.
 * Real asset types will replace these once the feature ships.
 */
export const REQUIRED_ASSET_TYPES = ['Asset_A', 'Asset_B'] as const
export type RequiredAssetType = typeof REQUIRED_ASSET_TYPES[number]

/**
 * property_assets.asset_type is a fixed enum with no 'Asset_A'/'Asset_B'
 * values. Until real asset types are assigned, each placeholder maps to a
 * low-traffic enum value ('generator', 'solar_system') so discovery rows can
 * be persisted without an enum migration. This mapping is temporary scaffolding.
 */
export const ASSET_TYPE_ENUM_MAP: Record<RequiredAssetType, AssetType> = {
  Asset_A: 'generator',
  Asset_B: 'solar_system',
}

export const ASSET_DISCOVERY_SECTION = 'Asset Discovery'

export function discoveryTaskLabel(placeholder: RequiredAssetType): string {
  return `Capture asset details: ${placeholder}`
}
