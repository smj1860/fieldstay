import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import {
  CONTENT_FIELDS,
  REDACTED_CONTENT_FIELDS,
  type NormalizedProperty,
} from '@/lib/properties/normalize'

/**
 * Shared writer for single-call providers (e.g. Hospitable, whose
 * include=details returns every field in one request). Providers whose API
 * requires a separate fan-out detail fetch per property (e.g. OwnerRez)
 * don't fit this writer's single-pass shape — see ownerrez/initial-sync.ts,
 * which has its own multi-stage flow but can still call
 * logContentOverwrites() directly for the same audit behavior.
 *
 * The PMS is always the source of truth: every field is overwritten on
 * every sync, including the four PM-editable content fields (wifi_name,
 * wifi_password, access_instructions, house_manual). Before overwriting,
 * logContentOverwrites() compares against the existing row and writes an
 * audit_events entry for any content field whose value is about to change
 * from a real, existing, non-null value — a recoverability trail, not a
 * block on the overwrite itself.
 *
 * Returns a map of external_id → FieldStay property UUID.
 */
export async function upsertNormalizedProperties(
  orgId: string,
  provider: string,
  normalized: NormalizedProperty[]
): Promise<Record<string, string>> {
  const idMap: Record<string, string> = {}
  if (!normalized.length) return idMap

  const supabase = createServiceClient()

  // Fetch existing content field values BEFORE the upsert, so we can diff
  // against what's about to be written.
  const { data: existingRows } = await supabase
    .from('properties')
    .select('external_id, wifi_name, wifi_password, access_instructions, house_manual')
    .eq('org_id', orgId)
    .eq('external_source', provider)
    .in('external_id', normalized.map((n) => n.external_id))

  const existingByExternalId = new Map(
    (existingRows ?? []).map((row) => [row.external_id as string, row])
  )

  const rows = normalized.map((n) => ({
    org_id:                  orgId,
    external_id:             n.external_id,
    external_source:         provider,
    name:                    n.name,
    address:                 n.address,
    city:                    n.city,
    state:                   n.state,
    zip:                     n.zip,
    bedrooms:                n.bedrooms,
    bathrooms:               n.bathrooms,
    max_guests:              n.max_guests,
    checkin_time:            n.checkin_time,
    checkout_time:           n.checkout_time,
    timezone:                n.timezone,
    amenities:               n.amenities,
    smoking_allowed:         n.smoking_allowed,
    pets_allowed:            n.pets_allowed,
    events_allowed:          n.events_allowed,
    wifi_name:               n.wifi_name,
    wifi_password:           n.wifi_password,
    access_instructions:     n.access_instructions,
    house_manual:            n.house_manual,
    property_type:           'other' as const,
    avg_stay_length:         0,
    avg_turnovers_per_month: 0,
    setup_steps_completed:   {} as Record<string, boolean>,
    is_active:               true,
  }))

  const { error: upsertError } = await supabase
    .from('properties')
    .upsert(rows, { onConflict: 'external_id,external_source' })

  if (upsertError) {
    throw new Error(`Properties upsert failed: ${upsertError.message}`)
  }

  const { data: upserted, error: selectError } = await supabase
    .from('properties')
    .select('id, external_id')
    .eq('org_id', orgId)
    .eq('external_source', provider)
    .in('external_id', normalized.map((n) => n.external_id))

  if (selectError) {
    throw new Error(`Properties re-select after upsert failed: ${selectError.message}`)
  }

  await Promise.all(
    (upserted ?? []).map((row) => {
      idMap[row.external_id as string] = row.id as string

      const existing = existingByExternalId.get(row.external_id as string)
      const incoming = normalized.find((n) => n.external_id === row.external_id)
      if (!existing || !incoming) return undefined

      return logContentOverwrites(orgId, row.id as string, provider, existing, incoming)
    })
  )

  await backfillCleaningCost(supabase, normalized, idMap)

  return idMap
}

/**
 * Fills properties.cleaning_cost from PMS fee data, but ONLY when the
 * column is currently null — a PM's own entry (what FieldStay actually
 * pays a cleaner) is never overwritten, unlike the always-overwrite
 * Facts/Content fields above. See NormalizedProperty.cleaning_cost's
 * doc comment for why this field gets different treatment.
 */
async function backfillCleaningCost(
  supabase:   ReturnType<typeof createServiceClient>,
  normalized: NormalizedProperty[],
  idMap:      Record<string, string>
): Promise<void> {
  await Promise.all(
    normalized.map(async (n) => {
      if (n.cleaning_cost == null || n.cleaning_cost <= 0) return
      const propertyId = idMap[n.external_id]
      if (!propertyId) return

      const { error } = await supabase
        .from('properties')
        .update({ cleaning_cost: n.cleaning_cost })
        .eq('id', propertyId)
        .is('cleaning_cost', null)

      if (error) {
        console.error(`[backfillCleaningCost] update failed for property ${propertyId}: ${error.message}`)
      }
    })
  )
}

/**
 * Writes an audit_events entry for each content field (wifi_name,
 * wifi_password, access_instructions, house_manual) whose existing,
 * non-null value is about to be replaced with a different value.
 * wifi_password's actual value is never logged — only that it changed.
 * Non-fatal: logAuditEvents already swallows its own failures.
 */
async function logContentOverwrites(
  orgId:      string,
  propertyId: string,
  provider:   string,
  existing:   Record<string, unknown>,
  incoming:   NormalizedProperty
): Promise<void> {
  const entries = []

  for (const field of CONTENT_FIELDS) {
    const previousValue = existing[field] as string | null
    const newValue       = incoming[field]

    if (!previousValue || previousValue === newValue) continue

    const redacted = REDACTED_CONTENT_FIELDS.has(field)

    entries.push({
      orgId,
      action:     'property.content.overwritten_by_sync' as const,
      targetType: 'property',
      targetId:   propertyId,
      metadata: {
        provider,
        field,
        ...(redacted
          ? { redacted: true }
          : { previous_value: previousValue, new_value: newValue }),
      },
    })
  }

  await logAuditEvents(entries)
}
