import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { geocodeZip } from '@/lib/geocoding'
import { reportError } from '@/lib/observability/report-error'
import { logAuditEvents } from '@/lib/audit'
import {
  CONTENT_FIELDS,
  REDACTED_CONTENT_FIELDS,
  type NormalizedProperty,
} from '@/lib/properties/normalize'

/**
 * The pre-upsert snapshot of the four PM-editable content fields, keyed for
 * the overwrite diff below. A type alias rather than an interface on purpose:
 * only an alias gets the implicit index signature that makes it assignable to
 * logContentOverwrites' `Record<string, unknown>` parameter.
 */
type ExistingContentRow = {
  external_id:         string | null
  wifi_name:           string | null
  wifi_password:       string | null
  access_instructions: string | null
  house_manual:        string | null
}

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

  const supabase = createServiceClient({ system: 'lib/properties/upsert-normalized' })

  // Fetch existing content field values BEFORE the upsert, so we can diff
  // against what's about to be written.
  // Degrade, don't throw: these rows feed the content-overwrite audit log
  // below, not the upsert itself, so a failure costs the log entry rather
  // than the sync. tryUnwrap still records that it happened.
  //
  // Paginated because the result is sized by the `.in()` list, not by a single
  // parent row: a PMS sync passes every property in the org at once, so a
  // large account silently loses its overwrite audit trail past max_rows.
  let existingRows: ExistingContentRow[] = []
  try {
    existingRows = await fetchAllRows<ExistingContentRow>(
      (from, to) => supabase
        .from('properties')
        .select('external_id, wifi_name, wifi_password, access_instructions, house_manual')
        .eq('org_id', orgId)
        .eq('external_source', provider)
        .in('external_id', normalized.map((n) => n.external_id))
        .order('external_id')
        .range(from, to),
      { label: 'lib.properties.upsert-normalized.existing' },
    )
  } catch (err) {
    // Degrade, don't throw — see above. fetchAllRows throws on failure, so the
    // catch is what makes it non-fatal; reportError keeps it visible.
    console.error('[upsertNormalizedProperties] existing-content read failed', err)
    reportError(err, { site: 'lib.properties.upsert-normalized.existing', orgId })
  }

  const existingByExternalId = new Map(
    existingRows.map((row) => [row.external_id as string, row])
  )

  // Provider-supplied coordinates are written in the same upsert, but only
  // for the rows that HAVE them, as a separate batch.
  //
  // Not one batch with `lat: n.lat ?? null`: a bulk upsert sends the union of
  // every row's keys, so a single row carrying lat would add the column to the
  // statement for ALL of them and write NULL into the rest — clobbering
  // coordinates an earlier sync or the geocode pass below had already
  // resolved. That is the exact `?? null`-on-a-partial-payload defect
  // unit/guardrails/upload-payload-null-fields.test.ts exists for, and it is
  // no less real on the server side.
  type GeolocatedProperty = NormalizedProperty & { lat: number; lng: number }
  const hasCoords = (n: NormalizedProperty): n is GeolocatedProperty =>
    typeof n.lat === 'number' && typeof n.lng === 'number'

  const buildRow = (n: NormalizedProperty) => ({
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
  })

  const withCoords    = normalized.filter(hasCoords)
  const withoutCoords = normalized.filter((n) => !hasCoords(n))

  // Two key-consistent batches instead of one mixed one. Each is skipped when
  // empty, so a provider that supplies coordinates for every property (Hostex)
  // and one that supplies none (Hospitable, OwnerRez) both issue exactly one
  // upsert, unchanged from before.
  type PropertyUpsertRow = ReturnType<typeof buildRow> & { lat?: number; lng?: number }

  // Written as two explicit calls rather than a loop over a batch array: the
  // loop shape reads as an N+1 to unit/guardrails/n-plus-one-loops.test.ts and
  // would need an exception entry, when the truth is simply that there are at
  // most two statements here.
  const upsertBatch = async (batch: PropertyUpsertRow[]): Promise<void> => {
    if (!batch.length) return
    const { error: upsertError } = await supabase
      .from('properties')
      .upsert(batch, { onConflict: 'org_id,external_id,external_source' })

    if (upsertError) {
      throw new Error(`Properties upsert failed: ${upsertError.message}`)
    }
  }

  await upsertBatch(withoutCoords.map(buildRow))
  await upsertBatch(withCoords.map((n) => ({ ...buildRow(n), lat: n.lat, lng: n.lng })))

  // Bounded by the batch that was just upserted, not left open. This read maps
  // external_id -> id for the rows written immediately above, so a truncation
  // does not merely shorten a list: the caller silently loses the ids of every
  // property past the cap and skips whatever it was going to do with them.
  // `.limit(normalized.length)` ties the ceiling to the write it is reading
  // back, so it can never be the thing that truncates.
  const { data: upserted, error: selectError } = await supabase
    .from('properties')
    .select('id, external_id')
    .eq('org_id', orgId)
    .eq('external_source', provider)
    .in('external_id', normalized.map((n) => n.external_id))
    .limit(normalized.length)

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
  await geocodeMissingCoordinates(supabase, orgId, provider, normalized)

  return idMap
}

/**
 * Unique ZIPs geocoded per import pass.
 *
 * Coordinates dedupe hard — a portfolio in one market is often one or two
 * ZIPs — so this bounds the Mapbox calls without bounding the properties
 * covered. Anything past the cap is left for geocodingBackfill, which is a
 * real safety net now that it has a schedule.
 */
const IMPORT_GEOCODE_ZIP_LIMIT = 50

/**
 * Resolves lat/lng for freshly-imported PMS properties.
 *
 * PMS imports arrived with NO COORDINATES AT ALL. Neither the Hospitable nor
 * the Hostaway normalizer carries lat/lng, this shared upsert never wrote
 * them, and the geocodingBackfill function that was supposed to catch it is
 * triggered by an event NOTHING SENDS — so the gap was permanent rather than
 * eventual. Only the OwnerRez path geocoded, because it does so inline in its
 * own server action.
 *
 * It is not cosmetic. auto-assign-turnover.ts scores crew proximity only when
 * BOTH the property and the crew member have coordinates, so a
 * coordinate-less property silently drops the distance signal and assigns on
 * reliability and capacity alone — with nothing on screen saying so. The first
 * live Hospitable org hit exactly this: one property, no coordinates,
 * auto-assign in autopilot mode.
 *
 * Never throws, and never blocks the import: geocodeZip already returns null
 * for every failure mode, and a property without coordinates is the status quo
 * this is improving on, not a regression.
 */
async function geocodeMissingCoordinates(
  supabase:   ReturnType<typeof createServiceClient>,
  orgId:      string,
  provider:   string,
  normalized: NormalizedProperty[]
): Promise<void> {
  try {
    const externalIds = normalized.filter((n) => n.zip).map((n) => n.external_id)
    if (!externalIds.length) return

    // Only rows STILL missing coordinates. The upsert above does not write
    // lat/lng, so a property geocoded on an earlier sync (or corrected by hand
    // by the PM) keeps what it has — re-geocoding it would overwrite a better
    // value with a ZIP centroid.
    const { data: missing, error } = await supabase
      .from('properties')
      .select('id, zip')
      .eq('org_id', orgId)
      .eq('external_source', provider)
      .in('external_id', externalIds)
      .is('lat', null)
      .not('zip', 'is', null)
      .limit(externalIds.length)

    if (error || !missing?.length) return

    const uniqueZips = [...new Set(missing.map((p) => p.zip as string))]
      .slice(0, IMPORT_GEOCODE_ZIP_LIMIT)

    const coordsByZip = new Map<string, { lat: number; lng: number } | null>()
    for (const zip of uniqueZips) {
      coordsByZip.set(zip, await geocodeZip(zip))
    }

    // Grouped by resolved coordinate so properties sharing a ZIP write in one
    // statement, the same shape geocodingBackfill uses.
    const idsByCoord = new Map<string, { lat: number; lng: number; ids: string[] }>()
    for (const prop of missing) {
      const coords = coordsByZip.get(prop.zip as string)
      if (!coords) continue
      const key = `${coords.lat},${coords.lng}`
      const entry = idsByCoord.get(key) ?? { ...coords, ids: [] }
      entry.ids.push(prop.id as string)
      idsByCoord.set(key, entry)
    }

    for (const { lat, lng, ids } of idsByCoord.values()) {
      const { error: updateError } = await supabase
        .from('properties').update({ lat, lng }).in('id', ids)
      if (updateError) {
        console.warn('[upsertNormalizedProperties] geocode write failed', updateError.message)
      }
    }
  } catch (err) {
    // A geocoding failure must never fail a property import.
    console.error('[upsertNormalizedProperties] geocode pass failed', err)
    reportError(err, { site: 'lib.properties.upsert-normalized.geocode', orgId })
  }
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
