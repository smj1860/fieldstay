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

// Maps normalized amenity keys (lowercased, underscored) to the optional
// AssetTypes that their presence confirms. Only types in this map are
// eligible for is_na seeding — mandatory types (hvac, refrigerator,
// water_heater, etc.) are never touched here.
//
// Built for OwnerRez's normalizeAmenities() output ("Hot Tub" → "hot_tub",
// "Swimming Pool" → "swimming_pool"), which needs many synonym variants
// since OwnerRez amenities come from PMs' free-text listing titles.
// Hospitable's amenities are a fixed, standardized slug set synced from
// Airbnb's own controlled vocabulary — unconfirmed whether it uses the same
// slugs for these specific (pool/hot tub/solar/etc.) amenities, but a
// mismatch is harmless: this only marks a type "confirmed absent," so a
// missed match just means no extra signal for that property, not an error.
export const OPTIONAL_ASSET_AMENITY_MAP: Partial<Record<AssetType, string[]>> = {
  pool_pump:               ['swimming_pool', 'private_pool', 'shared_pool', 'indoor_pool', 'outdoor_pool', 'pool', 'lap_pool'],
  hot_tub:                 ['hot_tub', 'jacuzzi', 'spa', 'jetted_tub', 'whirlpool'],
  well_pump:               ['well_water', 'well_pump', 'private_well'],
  solar_inverter:          ['solar_panels', 'solar_power', 'solar_energy', 'solar'],
  whole_home_water_filter: ['water_filtration', 'water_filter', 'whole_home_water_filter'],
  heated_tile_system:      ['heated_floors', 'heated_tile', 'radiant_heat', 'in_floor_heat', 'heated_bathroom_floor'],
  coffee_station:          ['coffee_station', 'espresso_machine', 'nespresso', 'coffee_bar', 'keurig'],
  toaster_oven:            ['toaster_oven', 'countertop_oven', 'convection_oven'],
}

/**
 * Marks optional asset types (see OPTIONAL_ASSET_AMENITY_MAP) as confirmed
 * absent (is_na: true) when none of their trigger amenity slugs are present
 * at the property — dropping them from the crew's discovery queue
 * immediately instead of waiting for a turnover to confirm absence.
 *
 * Non-destructive: existing property_assets rows (crew-captured,
 * PM-entered, or already seeded) are fetched first and excluded from the
 * insert. Non-fatal by design — callers should catch and log, not let a
 * failure here block the rest of a sync. Pass propertyIds to scope to
 * specific properties — omit to cover every active property with amenity
 * data in the org.
 */
export async function seedAbsentOptionalAssetsFromAmenities(
  orgId: string,
  propertyIds?: string[]
): Promise<{ seeded: number; total: number }> {
  const supabase      = createServiceClient()
  const optionalTypes = Object.keys(OPTIONAL_ASSET_AMENITY_MAP) as AssetType[]

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

    // Determine which optional types are absent from this property's amenities
    const absentTypes = optionalTypes.filter((assetType) => {
      const triggers = OPTIONAL_ASSET_AMENITY_MAP[assetType] ?? []
      return !triggers.some((trigger) => amenities[trigger] === true)
    })

    if (!absentTypes.length) continue

    // Skip types that already have an active property_assets row — never
    // overwrite crew-captured or PM-entered records.
    const { data: existingAssets } = await supabase
      .from('property_assets')
      .select('asset_type')
      .eq('property_id', property.id as string)
      .eq('is_active', true)
      .in('asset_type', absentTypes)

    const existingTypes = new Set((existingAssets ?? []).map((a) => a.asset_type as AssetType))
    const stubs = absentTypes
      .filter((assetType) => !existingTypes.has(assetType))
      .map((assetType) => ({
        org_id:      orgId,
        property_id: property.id as string,
        asset_type:  assetType,
        name:        assetTypeDisplayName(assetType),
        is_active:   true,
        is_na:       true,
      }))

    if (!stubs.length) continue

    const { error } = await supabase.from('property_assets').insert(stubs)
    if (!error) seeded++
  }

  return { seeded, total: propertiesWithAmenities.length }
}
