// lib/evidence/checkin.ts
//
// A crew visit check-in: one location fix per turnover, taken at Start Turnover,
// that every photo sealed during the visit inherits. It is a ledger event with
// no bytes behind it (same shape as proof_of_care): kind 'checkin', source the
// turnover, sha256 all zeros.
//
// TRUST BOUNDARY. The device claims a fix and a clock. The server decides the
// rest: captured_at is corrected the way a photo's is, the property's pin comes
// from OUR row (never the client), and the distance is computed here.
//
// What this proves: the crew member was at the property when the visit started.
// What it does not: the phone's position at the instant of each photo.
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'
import { unwrap } from '@/lib/supabase/unwrap'
import { resolveCapturedAt } from '@/lib/evidence/seal'
import { distanceFeet, formatDistance, GEOFENCE_WARN_FT } from '@/lib/evidence/geo'
import { createPmNotification } from '@/lib/inngest/helpers'

export interface CheckinFixInput {
  lat:             number
  lng:             number
  gps_accuracy_ft: number
  captured_at:     string
  device_now:      string
  attempt:         number
}

export type SealCheckinResult =
  | { ok: true; eventId: string; propertyName: string; distanceFt: number | null; offsite: boolean; notGeocoded: boolean; duplicate: boolean }
  | { ok: false }

interface PropertyPin {
  name:               string
  lat:                number | null
  lng:                number | null
  geofence_radius_ft: number | null
}

/** The ledger path for one check-in. The first is '<org>/turnover-<id>/checkin'; a deliberate re-check-in appends its attempt number. */
export function checkinStoragePath(orgId: string, turnoverId: string, attempt: number): string {
  const suffix = attempt > 1 ? `-${attempt}` : ''
  return `${orgId}/turnover-${turnoverId}/checkin${suffix}`
}

/** A pin of (0, 0) is a failed geocode, not Null Island. */
function hasPin(p: PropertyPin): p is PropertyPin & { lat: number; lng: number } {
  return p.lat !== null && p.lng !== null && !(p.lat === 0 && p.lng === 0)
}

async function loadPin(supabase: SupabaseClient, orgId: string, propertyId: string): Promise<PropertyPin | null> {
  const res = await supabase
    .from('properties')
    .select('name, lat, lng, geofence_radius_ft')
    .eq('org_id', orgId)
    .eq('id', propertyId)
    .maybeSingle()
  const row = unwrap(res, { site: 'lib.evidence.checkin.property', orgId })
  return row ? (row as PropertyPin) : null
}

async function recoverCheckin(
  supabase: SupabaseClient, orgId: string, storagePath: string, propertyName: string,
): Promise<SealCheckinResult | null> {
  const { data, error } = await supabase
    .from('evidence_events')
    .select('id, metadata')
    .eq('org_id', orgId).eq('bucket', 'turnover-photos').eq('storage_path', storagePath).eq('kind', 'checkin')
    .maybeSingle()
  if (error) reportError(error, { site: 'lib.evidence.checkin.replayLookup', orgId })
  if (!data) return null
  const meta = (data.metadata ?? {}) as Record<string, unknown>
  const distance = typeof meta.distance_to_property_ft === 'number' ? meta.distance_to_property_ft : null
  return {
    ok: true, eventId: data.id, propertyName, distanceFt: distance,
    offsite: meta.offsite === true, notGeocoded: meta.property_not_geocoded === true, duplicate: true,
  }
}

export async function sealCheckin(
  supabase: SupabaseClient,   // service client; the route names why
  input: { orgId: string; propertyId: string; turnoverId: string; crewId: string; fix: CheckinFixInput },
): Promise<SealCheckinResult> {
  const { orgId, propertyId, turnoverId, crewId, fix } = input
  const property = await loadPin(supabase, orgId, propertyId)
  if (!property) return { ok: false }

  const timing = resolveCapturedAt(fix.captured_at, fix.device_now, Date.now())
  const pinned = hasPin(property)
  const distanceFt = pinned ? Math.round(distanceFeet({ lat: fix.lat, lng: fix.lng }, { lat: property.lat, lng: property.lng })) : null
  const radius = property.geofence_radius_ft ?? GEOFENCE_WARN_FT
  // Never blocking and never flagged without a pin: a bad geocode must not stop a turnover or cry wolf.
  const offsite = distanceFt !== null && distanceFt > radius
  const storagePath = checkinStoragePath(orgId, turnoverId, fix.attempt)

  const { data, error } = await supabase.from('evidence_events').insert({
    org_id: orgId, property_id: propertyId,
    kind: 'checkin', source_table: 'turnovers', source_id: turnoverId,
    bucket: 'turnover-photos', storage_path: storagePath,
    sha256: '0'.repeat(64), hash_verified: false,
    captured_at: timing.capturedAt, captured_at_source: timing.source,
    device_captured_at: timing.source === 'device' ? fix.captured_at : null,
    device_clock_offset_seconds: timing.offsetSeconds,
    lat: fix.lat, lng: fix.lng, gps_accuracy_ft: fix.gps_accuracy_ft,
    captured_by_kind: 'crew', captured_by_id: crewId,
    turnover_id: turnoverId,
    metadata: {
      distance_to_property_ft: distanceFt, offsite, attempt: fix.attempt,
      geofence_radius_ft: radius, property_not_geocoded: !pinned,
    },
  }).select('id').single()

  if (!error) return { ok: true, eventId: data.id, propertyName: property.name, distanceFt, offsite, notGeocoded: !pinned, duplicate: false }
  if (error.code === '23505') {
    const replay = await recoverCheckin(supabase, orgId, storagePath, property.name)
    if (replay) return replay
  }
  reportError(error, { site: 'lib.evidence.checkin.insert', orgId })
  return { ok: false }
}

/**
 * The PM bells a check-in can raise. Both dedupe on a stable key, so a replayed
 * check-in (an outbox retry) raises nothing twice: one per event for off-site,
 * one per property for a missing pin.
 */
export async function notifyCheckin(
  supabase: SupabaseClient,
  input: { orgId: string; propertyId: string; turnoverId: string; crewId: string; result: Extract<SealCheckinResult, { ok: true }> },
): Promise<void> {
  const { orgId, propertyId, turnoverId, crewId, result } = input
  const propertyName = result.propertyName

  if (result.notGeocoded) {
    await createPmNotification(supabase, {
      orgId, type: 'evidence_no_pin', severity: 'amber',
      title:     `Add a map pin for ${propertyName}`,
      subtitle:  'Crew check-ins cannot be compared to the address until the property has a location. Open the property and verify the address.',
      href:      `/properties/${propertyId}/setup/details`,
      dedupeKey: `evidence-no-pin-${propertyId}`,
    })
  }
  if (!result.offsite || result.distanceFt === null) return

  const crewRes = await supabase.from('crew_members').select('name').eq('org_id', orgId).eq('id', crewId).maybeSingle()
  const crewName = (unwrap(crewRes, { site: 'lib.evidence.checkin.crewName', orgId }) as { name?: string | null } | null)?.name?.trim()
  await createPmNotification(supabase, {
    orgId, type: 'evidence_offsite_checkin', severity: 'amber',
    title:     'Turnover started away from the property',
    subtitle:  `${crewName || 'A crew member'} checked in about ${formatDistance(result.distanceFt)} from ${propertyName}. Open the turnover to review.`,
    href:      `/turnovers/${turnoverId}`,
    dedupeKey: `evidence-offsite-${result.eventId}`,
  })
}
