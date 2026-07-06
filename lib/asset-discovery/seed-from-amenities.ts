import { createServiceClient } from '@/lib/supabase/server'
import type { AssetType } from '@/types/database'
import { assetTypeDisplayName } from '@/lib/asset-discovery/config'

// Amenity slugs (as returned by connected PMS integrations, e.g. Hospitable)
// that confirm an asset type is physically present at the property. Only
// unambiguous 1:1 matches are included — amenities like "heating"/"ac"
// (could be a space heater/window unit, not necessarily a full HVAC
// system) or "hot_water" (doesn't confirm a discrete, inspectable water
// heater unit) are intentionally excluded to avoid seeding assets we can't
// actually confirm from a simple boolean amenity flag.
const PRESENT_ASSET_AMENITY_MAP: Partial<Record<AssetType, string[]>> = {
  washer:            ['washer'],
  dryer:             ['dryer'],
  dishwasher:        ['dishwasher'],
  microwave:         ['microwave'],
  refrigerator:      ['refrigerator'],
  oven_range:        ['oven', 'stove'],
  fire_extinguisher: ['fire_extinguisher'],
}

/**
 * Creates bare-stub, active property_assets rows (is_na: false, no
 * make/model) for asset types a connected PMS integration's amenity data
 * confirms are physically present — giving PMs an inventory entry
 * immediately instead of waiting for crew to discover it during a
 * turnover.
 *
 * Crew discovery is NOT skipped: getMissingAssetDiscoveryTypes() only
 * considers a type verified once make/model/photo_url/is_na is set, none
 * of which this seeds, so the checklist prompt to "capture asset details"
 * (make/model/photo) still fires normally during the next turnover.
 *
 * Non-destructive: never duplicates or overwrites an existing active
 * property_assets row for the same type. Pass propertyIds to scope to
 * specific properties (e.g. an incremental sync's affected property) —
 * omit to cover every active property with amenity data in the org.
 */
export async function seedPresentAssetsFromAmenities(
  orgId: string,
  propertyIds?: string[]
): Promise<{ seeded: number; total: number }> {
  const supabase     = createServiceClient()
  const presentTypes = Object.keys(PRESENT_ASSET_AMENITY_MAP) as AssetType[]

  let propertyQuery = supabase
    .from('properties')
    .select('id, amenities')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .not('amenities', 'is', null)

  if (propertyIds?.length) {
    propertyQuery = propertyQuery.in('id', propertyIds)
  }

  const { data: propertiesWithAmenities } = await propertyQuery
  if (!propertiesWithAmenities?.length) return { seeded: 0, total: 0 }

  let seeded = 0

  for (const property of propertiesWithAmenities) {
    const amenities = (property.amenities ?? {}) as Record<string, boolean>

    const presentAssetTypes = presentTypes.filter((assetType) => {
      const triggers = PRESENT_ASSET_AMENITY_MAP[assetType] ?? []
      return triggers.some((trigger) => amenities[trigger] === true)
    })

    if (!presentAssetTypes.length) continue

    // Skip types that already have an active property_assets row — never
    // duplicate or overwrite a crew-captured or PM-entered record.
    const { data: existingAssets } = await supabase
      .from('property_assets')
      .select('asset_type')
      .eq('property_id', property.id as string)
      .eq('is_active', true)
      .in('asset_type', presentAssetTypes)

    const existingTypes = new Set((existingAssets ?? []).map((a) => a.asset_type as AssetType))
    const stubs = presentAssetTypes
      .filter((assetType) => !existingTypes.has(assetType))
      .map((assetType) => ({
        org_id:      orgId,
        property_id: property.id as string,
        asset_type:  assetType,
        name:        assetTypeDisplayName(assetType),
        is_active:   true,
      }))

    if (!stubs.length) continue

    const { error } = await supabase.from('property_assets').insert(stubs)
    if (!error) seeded++
  }

  return { seeded, total: propertiesWithAmenities.length }
}
