import type { SupabaseClient } from '@supabase/supabase-js'
import {
  REQUIRED_ASSET_TYPES,
  ASSET_TYPE_ENUM_MAP,
  ASSET_DISCOVERY_SECTION,
  discoveryTaskLabel,
  type RequiredAssetType,
} from '@/lib/asset-discovery/config'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DBClient = SupabaseClient<any>

/**
 * Returns the placeholder asset types that have not yet been discovered
 * (verified) for this property. A type drops off once an active
 * property_assets row exists for it with make, model, photo_url, or is_na set.
 */
export async function getMissingAssetDiscoveryTypes(
  supabase:   DBClient,
  propertyId: string,
): Promise<RequiredAssetType[]> {
  const mappedEnumValues = REQUIRED_ASSET_TYPES.map(t => ASSET_TYPE_ENUM_MAP[t])
  const { data: existing } = await supabase
    .from('property_assets')
    .select('asset_type, make, model, photo_url, is_na')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .in('asset_type', mappedEnumValues)

  const verifiedEnumValues = new Set(
    (existing ?? [])
      .filter(row => row.make != null || row.model != null || row.photo_url != null || row.is_na === true)
      .map(row => row.asset_type as string)
  )

  return REQUIRED_ASSET_TYPES.filter(
    placeholder => !verifiedEnumValues.has(ASSET_TYPE_ENUM_MAP[placeholder])
  )
}

/**
 * Builds the checklist_instance_items rows for undiscovered asset types.
 * Mandatory and non_deletable so property managers cannot remove them from
 * the checklist builder UI.
 */
export function buildAssetDiscoveryItems(
  instanceId:  string,
  turnoverId:  string,
  missing:     RequiredAssetType[],
  startSortOrder: number,
) {
  return missing.map((placeholder, i) => ({
    instance_id:           instanceId,
    turnover_id:           turnoverId,
    section_name:          ASSET_DISCOVERY_SECTION,
    task:                  discoveryTaskLabel(placeholder),
    requires_photo:        false,
    photo_reason:          null,
    notes:                 null,
    sort_order:            startSortOrder + i,
    is_completed:          false,
    is_mandatory:          true,
    non_deletable:         true,
    asset_discovery_type:  placeholder,
  }))
}
