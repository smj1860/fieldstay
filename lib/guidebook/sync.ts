import { createServiceClient } from '@/lib/supabase/server'
import { generateBaseSlug, generateUniqueSlugsForProperties } from '@/lib/guidebook/slug'

/**
 * Ensures an org has a guidebook_configurations row, starting the 30-day
 * trial if one doesn't already exist. Idempotent — never resets an
 * existing trial. Call once per PMS connection (OwnerRez, Hospitable, ...).
 */
export async function ensureGuidebookConfiguration(orgId: string): Promise<void> {
  const supabase    = createServiceClient()
  const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  await supabase
    .from('guidebook_configurations')
    .upsert(
      { org_id: orgId, is_active: true, trial_ends_at: trialEndsAt },
      { onConflict: 'org_id', ignoreDuplicates: true }
    )
}

/**
 * Auto-creates blank guidebook_property_configs rows (is_published: false)
 * for any active property in the org that doesn't have one yet, with a
 * unique slug. Pass propertyIds to scope to specific properties (e.g. an
 * incremental sync's affected set) — omit to cover every active property
 * in the org.
 */
export async function createGuidebookPropertyConfigsForProperties(
  orgId: string,
  propertyIds?: string[]
): Promise<void> {
  const supabase = createServiceClient()

  let propertyQuery = supabase
    .from('properties')
    .select('id, name')
    .eq('org_id', orgId)
    .eq('is_active', true)

  if (propertyIds?.length) {
    propertyQuery = propertyQuery.in('id', propertyIds)
  }

  const { data: allProperties } = await propertyQuery
  if (!allProperties?.length) return

  const { data: existingConfigs } = await supabase
    .from('guidebook_property_configs')
    .select('property_id')
    .eq('org_id', orgId)
    .in('property_id', allProperties.map((p) => p.id))

  const alreadyConfigured = new Set((existingConfigs ?? []).map((c) => c.property_id))
  const newProperties      = allProperties.filter((p) => !alreadyConfigured.has(p.id))
  if (newProperties.length === 0) return

  const slugMap = await generateUniqueSlugsForProperties(newProperties)

  const rows = newProperties.map((p) => ({
    org_id:       orgId,
    property_id:  p.id,
    slug:         slugMap.get(p.id) ?? generateBaseSlug(p.name),
    is_published: false,   // PM must explicitly publish
  }))

  await supabase
    .from('guidebook_property_configs')
    .upsert(rows, { onConflict: 'org_id,property_id', ignoreDuplicates: true })
}

/**
 * Copies provider-synced staging fields already on `properties`
 * (wifi_name, wifi_password, access_instructions, house_manual,
 * checkout_instructions) into the matching guidebook_property_configs
 * fields — but ONLY when the guidebook field is currently empty. Never
 * overwrites a PM-entered value. Pass propertyIds to scope to specific
 * properties — omit to cover every active property for this org+provider.
 */
export async function syncGuidebookConfigsFromProperty(
  orgId: string,
  externalSource: string,
  propertyIds?: string[]
): Promise<void> {
  const supabase = createServiceClient()

  let propertyQuery = supabase
    .from('properties')
    .select('id, wifi_name, wifi_password, access_instructions, house_manual, checkout_instructions')
    .eq('org_id', orgId)
    .eq('external_source', externalSource)
    .eq('is_active', true)

  if (propertyIds?.length) {
    propertyQuery = propertyQuery.in('id', propertyIds)
  }

  const { data: props } = await propertyQuery
  if (!props?.length) return

  const { data: configs } = await supabase
    .from('guidebook_property_configs')
    .select('id, property_id, wifi_network, wifi_password, check_in_instructions, house_rules, check_out_instructions')
    .eq('org_id', orgId)
    .in('property_id', props.map((p) => p.id))

  const configByPropertyId = new Map((configs ?? []).map((c) => [c.property_id, c]))

  for (const prop of props) {
    const config = configByPropertyId.get(prop.id)
    if (!config) continue // no guidebook config yet — createGuidebookPropertyConfigsForProperties handles creation

    const patch: Record<string, unknown> = {}

    if (!config.wifi_network           && prop.wifi_name)             patch.wifi_network           = prop.wifi_name
    if (!config.wifi_password          && prop.wifi_password)         patch.wifi_password          = prop.wifi_password
    if (!config.check_in_instructions  && prop.access_instructions)   patch.check_in_instructions  = prop.access_instructions
    if (!config.house_rules            && prop.house_manual)          patch.house_rules            = prop.house_manual
    if (!config.check_out_instructions && prop.checkout_instructions) patch.check_out_instructions = prop.checkout_instructions

    if (Object.keys(patch).length === 0) continue

    patch.updated_at = new Date().toISOString()

    await supabase
      .from('guidebook_property_configs')
      .update(patch)
      .eq('id', config.id)
  }
}
