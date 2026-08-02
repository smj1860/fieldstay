import { fetchAllRows } from '@/lib/inngest/paginate'
import type { DBClient } from '@/lib/supabase/server'
import type { AssetType } from '@/types/database'
import {
  REQUIRED_ASSET_TYPES,
  ASSET_DISCOVERY_SECTION,
  discoveryTaskLabel,
} from '@/lib/asset-discovery/config'

interface ExistingAssetRow {
  asset_type: string
  make:       string | null
  model:      string | null
  photo_url:  string | null
  is_na:      boolean | null
}

/**
 * Returns the required asset types that have not yet been discovered
 * (verified) for this property. A type drops off once an active
 * property_assets row exists for it with make, model, photo_url, or is_na set.
 */
export async function getMissingAssetDiscoveryTypes(
  supabase:   DBClient,
  orgId:      string,
  propertyId: string,
): Promise<AssetType[]> {
  // An empty result makes every required asset look undiscovered, so a
  // failed read would re-prompt for assets the property already has.
  //
  // org_id is redundant with property_id for correctness (a property belongs
  // to exactly one org) but not for safety: the only caller runs on a service
  // -role client, where RLS is not a backstop, so the tenant scope has to be
  // in the query itself.
  //
  // Paginated rather than left unbounded: one property with several units per
  // required type stays far under max_rows, but nothing in the query says so,
  // and truncation here fails in the expensive direction — a dropped row makes
  // an already-discovered asset look missing and re-prompts crew for it.
  // fetchAllRows throws on failure, which is the right direction for the same
  // reason.
  const existing = await fetchAllRows<ExistingAssetRow>(
    (from, to) => supabase
      .from('property_assets')
      .select('asset_type, make, model, photo_url, is_na')
      .eq('org_id', orgId)
      .eq('property_id', propertyId)
      .eq('is_active', true)
      .in('asset_type', REQUIRED_ASSET_TYPES)
      .order('asset_type')
      .range(from, to),
    { label: 'lib.asset-discovery.engine.existing' },
  )

  const verifiedTypes = new Set(
    existing
      .filter(row => row.make !== null || row.model !== null || row.photo_url !== null || row.is_na === true)
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
