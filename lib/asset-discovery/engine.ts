import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetType } from '@/types/database'
import {
  REQUIRED_ASSET_TYPES,
  ASSET_DISCOVERY_SECTION,
  discoveryTaskLabel,
} from '@/lib/asset-discovery/config'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DBClient = SupabaseClient<any>

/**
 * Returns the required asset types that have not yet been discovered
 * (verified) for this property. A type drops off once an active
 * property_assets row exists for it with make, model, photo_url, or is_na set.
 */
export async function getMissingAssetDiscoveryTypes(
  supabase:   DBClient,
  propertyId: string,
): Promise<AssetType[]> {
  const { data: existing } = await supabase
    .from('property_assets')
    .select('asset_type, make, model, photo_url, is_na')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .in('asset_type', REQUIRED_ASSET_TYPES)

  const verifiedTypes = new Set(
    (existing ?? [])
      .filter(row => row.make != null || row.model != null || row.photo_url != null || row.is_na === true)
      .map(row => row.asset_type as AssetType)
  )

  return REQUIRED_ASSET_TYPES.filter(assetType => !verifiedTypes.has(assetType))
}

/**
 * Builds the checklist_instance_items rows for undiscovered asset types.
 * Mandatory and non_deletable so property managers cannot remove them from
 * the checklist builder UI.
 */
export function buildAssetDiscoveryItems(
  instanceId:     string,
  turnoverId:     string,
  missing:        AssetType[],
  startSortOrder: number,
) {
  return missing.map((assetType, i) => ({
    instance_id:           instanceId,
    turnover_id:           turnoverId,
    section_name:          ASSET_DISCOVERY_SECTION,
    task:                  discoveryTaskLabel(assetType),
    requires_photo:        false,
    photo_reason:          null,
    notes:                 null,
    sort_order:            startSortOrder + i,
    is_completed:          false,
    is_mandatory:          true,
    non_deletable:         true,
    asset_discovery_type:  assetType,
  }))
}
