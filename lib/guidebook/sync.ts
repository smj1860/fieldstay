import { createServiceClient } from '@/lib/supabase/server'
import { generateBaseSlug, generateUniqueSlugsForProperties } from '@/lib/guidebook/slug'
import { unwrap, unwrapList } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import type { TablesUpdate } from '@/types/database'

/**
 * Ensures an org has a guidebook_configurations row, starting the 30-day
 * trial if one doesn't already exist. Idempotent — never resets an
 * existing trial. Call once per PMS connection (OwnerRez, Hospitable, ...).
 */
export async function ensureGuidebookConfiguration(orgId: string): Promise<void> {
  const supabase    = createServiceClient({ system: 'lib/guidebook/sync' })
  const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const res = await supabase
    .from('guidebook_configurations')
    .upsert(
      { org_id: orgId, is_active: true, trial_ends_at: trialEndsAt },
      { onConflict: 'org_id', ignoreDuplicates: true }
    )
  unwrap(res, { site: 'lib.guidebook.sync.ensureGuidebookConfiguration', orgId })
}

/**
 * Auto-creates blank guidebook_property_configs rows (is_published: false)
 * for any active property in the org that doesn't have one yet, with a
 * unique slug. Pass propertyIds to scope to specific properties (e.g. an
 * incremental sync's affected set) — omit to cover every active property
 * in the org.
 */
/** Row shape of the provider-sourced property read below. */
interface PropertyGuidebookSource {
  id:                    string
  wifi_name:             string | null
  wifi_password:         string | null
  access_instructions:   string | null
  house_manual:          string | null
  checkout_instructions: string | null
  smoking_allowed:       boolean | null
  pets_allowed:          boolean | null
  events_allowed:        boolean | null
}

export async function createGuidebookPropertyConfigsForProperties(
  orgId: string,
  propertyIds?: string[]
): Promise<void> {
  const supabase = createServiceClient({ system: 'lib/guidebook/sync' })

  // Paginated AND error-bound. Called from three Inngest sync functions, so
  // "the org's properties" is a cron-scale read: truncated at max_rows, the
  // properties past the cap never get a guidebook config and nothing says so.
  // The error was discarded outright, which made a failed read indistinguishable
  // from "this org has no active properties" — both produced zero configs and a
  // clean return. fetchAllRows throws, so the enclosing step retries instead.
  const allProperties = await fetchAllRows<{ id: string; name: string }>(
    (from, to) => {
      let q = supabase
        .from('properties')
        .select('id, name')
        .eq('org_id', orgId)
        .eq('is_active', true)
      if (propertyIds?.length) q = q.in('id', propertyIds)
      return q.order('id', { ascending: true }).range(from, to)
    },
    { label: `properties(guidebook-configs)[org=${orgId}]` },
  )
  if (!allProperties.length) return

  const existingConfigsRes = await supabase
    .from('guidebook_property_configs')
    .select('property_id')
    .eq('org_id', orgId)
    .in('property_id', allProperties.map((p) => p.id))
    .limit(allProperties.length)
  const existingConfigs = unwrapList(existingConfigsRes, { site: 'lib.guidebook.sync.createGuidebookPropertyConfigsForProperties.existingConfigs', orgId })

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

  const upsertRes = await supabase
    .from('guidebook_property_configs')
    .upsert(rows, { onConflict: 'org_id,property_id', ignoreDuplicates: true })
  unwrap(upsertRes, { site: 'lib.guidebook.sync.createGuidebookPropertyConfigsForProperties.upsert', orgId })
}

/**
 * Turns the OwnerRez-synced smoking/pets/events booleans into readable
 * house-rules lines. Only booleans present (non-null) are included — a
 * field OwnerRez never returned (or hasn't been confirmed against the real
 * API yet, see lib/integrations/types.ts's OwnerRezProperty rules fields)
 * simply produces no line rather than a false "not allowed" claim.
 */
export function buildRulesSummaryLines(prop: {
  smoking_allowed: boolean | null
  pets_allowed:    boolean | null
  events_allowed:  boolean | null
}): string[] {
  const lines: string[] = []
  if (prop.smoking_allowed !== null) lines.push(prop.smoking_allowed ? 'Smoking is allowed.' : 'No smoking.')
  if (prop.pets_allowed    !== null) lines.push(prop.pets_allowed    ? 'Pets are allowed.'    : 'No pets.')
  if (prop.events_allowed  !== null) lines.push(prop.events_allowed  ? 'Events/parties are allowed.' : 'No events or parties.')
  return lines
}

/**
 * Copies provider-synced staging fields already on `properties`
 * (wifi_name, wifi_password, access_instructions, house_manual,
 * checkout_instructions, smoking/pets/events_allowed) into the matching
 * guidebook_property_configs fields — but ONLY when the guidebook field is
 * currently empty. Never overwrites a PM-entered value. Pass propertyIds
 * to scope to specific properties — omit to cover every active property
 * for this org+provider.
 *
 * house_rules is free text with no structured smoking/pets/events columns
 * of its own on guidebook_property_configs, so the rules booleans are
 * rendered as short summary lines and combined with house_manual (if any)
 * on first fill — still gated on the guidebook field being empty, same as
 * every other field here.
 */
export async function syncGuidebookConfigsFromProperty(
  orgId: string,
  externalSource: string,
  propertyIds?: string[]
): Promise<void> {
  const supabase = createServiceClient({ system: 'lib/guidebook/sync' })

  // Same shape, same reasoning as the read above.
  const sourceProperties = await fetchAllRows<PropertyGuidebookSource>(
    (from, to) => {
      let q = supabase
        .from('properties')
        .select('id, wifi_name, wifi_password, access_instructions, house_manual, checkout_instructions, smoking_allowed, pets_allowed, events_allowed')
        .eq('org_id', orgId)
        .eq('external_source', externalSource)
        .eq('is_active', true)
      if (propertyIds?.length) q = q.in('id', propertyIds)
      return q.order('id', { ascending: true }).range(from, to)
    },
    { label: `properties(guidebook-content)[org=${orgId}]` },
  )

  const props = sourceProperties
  if (!props.length) return

  const configsRes = await supabase
    .from('guidebook_property_configs')
    .select('id, property_id, wifi_network, wifi_password, check_in_instructions, house_rules, check_out_instructions')
    .eq('org_id', orgId)
    .in('property_id', props.map((p) => p.id))
    .limit(props.length)
  const configs = unwrapList(configsRes, { site: 'lib.guidebook.sync.syncGuidebookConfigsFromProperty.configs', orgId })

  const configByPropertyId = new Map((configs ?? []).map((c) => [c.property_id, c]))

  await Promise.all(
    props.map(async (prop) => {
      const config = configByPropertyId.get(prop.id)
      if (!config) return // no guidebook config yet — createGuidebookPropertyConfigsForProperties handles creation

      const patch: TablesUpdate<'guidebook_property_configs'> = {}

      if (!config.wifi_network           && prop.wifi_name)             patch.wifi_network           = prop.wifi_name
      if (!config.wifi_password          && prop.wifi_password)         patch.wifi_password          = prop.wifi_password
      if (!config.check_in_instructions  && prop.access_instructions)   patch.check_in_instructions  = prop.access_instructions
      if (!config.check_out_instructions && prop.checkout_instructions) patch.check_out_instructions = prop.checkout_instructions

      if (!config.house_rules) {
        const rulesLines = buildRulesSummaryLines(prop)
        const houseRules = [...rulesLines, ...(prop.house_manual ? [prop.house_manual] : [])].join('\n')
        if (houseRules) patch.house_rules = houseRules
      }

      if (Object.keys(patch).length === 0) return

      patch.updated_at = new Date().toISOString()

      await supabase
        .from('guidebook_property_configs')
        .update(patch)
        .eq('id', config.id)
    })
  )
}
