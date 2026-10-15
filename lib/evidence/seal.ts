// lib/evidence/seal.ts
//
// The ONE place an evidence_events row of kind 'photo_sealed' is written.
// Every producer (crew route, PM quick-flag action, vendor portal route, the
// inspection-completed Inngest function) builds a SealInput and calls
// sealPhoto(). The function downloads the stored object with the service
// client, recomputes SHA-256, and records whether it matched the hash the
// client claimed. A mismatch is sealed anyway, flagged, and reported: a photo
// whose bytes changed between capture and storage is itself a finding, and
// losing the record of it would be worse than storing it.
import 'server-only'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'
import { hasOrgPrefix } from '@/lib/storage/object-path'
import type {
  EvidenceBucket, EvidenceCapturedByKind, EvidenceSourceTable,
} from '@/types/database'
import { bracketEvidenceEvent } from './bracket'

export const MAX_PLAUSIBLE_OFFSET_SECONDS = 24 * 60 * 60
export const EVIDENCE_OBJECT_TIMEOUT_MS   = 15_000

export interface SealInput {
  orgId:          string
  propertyId:     string
  bucket:         EvidenceBucket
  storagePath:    string
  sourceTable:    EvidenceSourceTable
  sourceId:       string
  /** Hash the producer claims for the bytes. Null when the producer never hashed (legacy backfill). */
  claimedSha256:  string | null
  byteSize:       number | null
  /** Raw device clock at capture, or null when the producer only has server time. */
  deviceCapturedAt: string | null
  /** Device clock at the moment of the sealing request, so skew can be measured. */
  deviceNow:      string | null
  lat:            number | null
  lng:            number | null
  gpsAccuracyM:   number | null
  capturedBy:     { kind: EvidenceCapturedByKind; id: string | null; label: string | null }
  turnoverId:     string | null
  workOrderId:    string | null
  inspectionId:   string | null
  /**
   * When the server first learned of a photo captured long before this call
   * (the backfill sweep: the pointer row's own timestamp). Used as captured_at
   * ONLY when there is no device clock, and always recorded as a server time.
   * Never used to fabricate a device claim.
   */
  observedAt?:    string | null
  metadata?:      Record<string, string | number | boolean | null>
}

export type SealResult =
  | { ok: true;  eventId: string; duplicate: boolean; hashVerified: boolean }
  | { ok: false; reason: 'object_missing' | 'bad_path' | 'insert_failed' }

function sha256Of(bytes: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

/**
 * resolveStartTime() from lib/inspections/start-time.ts, generalised: corrected
 * = device + (server - deviceNow), clamped to "not in the future", with the
 * offset capped at a day so a device with a wildly wrong clock records
 * provenance 'server' rather than a corrected time nobody should believe.
 */
export function resolveCapturedAt(
  deviceCapturedAt: string | null,
  deviceNow:        string | null,
  serverNowMs:      number,
): { capturedAt: string; source: 'server' | 'device'; offsetSeconds: number | null } {
  const serverIso = new Date(serverNowMs).toISOString()
  if (!deviceCapturedAt || !deviceNow) return { capturedAt: serverIso, source: 'server', offsetSeconds: null }

  const capMs = Date.parse(deviceCapturedAt)
  const nowMs = Date.parse(deviceNow)
  if (Number.isNaN(capMs) || Number.isNaN(nowMs)) return { capturedAt: serverIso, source: 'server', offsetSeconds: null }

  const offsetSeconds = Math.round((serverNowMs - nowMs) / 1000)
  if (Math.abs(offsetSeconds) > MAX_PLAUSIBLE_OFFSET_SECONDS) {
    return { capturedAt: serverIso, source: 'server', offsetSeconds: null }
  }

  const corrected = Math.min(capMs + offsetSeconds * 1000, serverNowMs)
  return { capturedAt: new Date(corrected).toISOString(), source: 'device', offsetSeconds }
}

/**
 * resolveCapturedAt() plus the backfill's server-observed time. The observed
 * time only ever replaces a SERVER receipt time (never a device claim), is
 * clamped to "not in the future", and stays labelled source 'server'.
 */
function timingFor(input: SealInput, serverNowMs: number): ReturnType<typeof resolveCapturedAt> {
  const timing = resolveCapturedAt(input.deviceCapturedAt, input.deviceNow, serverNowMs)
  const observed = input.observedAt ? Date.parse(input.observedAt) : Number.NaN
  if (timing.source !== 'server' || Number.isNaN(observed)) return timing
  return { ...timing, capturedAt: new Date(Math.min(observed, serverNowMs)).toISOString() }
}

/**
 * Replay: the first attempt landed and its response was lost. Recover the id so
 * the bracket step still runs (it is idempotent too). Null when the row cannot
 * be found, so the caller reports the original insert error.
 */
async function recoverReplay(supabase: SupabaseClient, input: SealInput): Promise<SealResult | null> {
  const { data: existing, error: existingErr } = await supabase
    .from('evidence_events')
    .select('id, hash_verified')
    .eq('org_id', input.orgId)
    .eq('bucket', input.bucket)
    .eq('storage_path', input.storagePath)
    .eq('kind', 'photo_sealed')
    .maybeSingle()
  if (existingErr) reportError(existingErr, { site: 'lib.evidence.seal.replayLookup', orgId: input.orgId })
  if (!existing) return null
  await bracketEvidenceEvent(supabase, { orgId: input.orgId, eventId: existing.id })
  return { ok: true, eventId: existing.id, duplicate: true, hashVerified: existing.hash_verified }
}

export async function sealPhoto(
  supabase: SupabaseClient,   // MUST be a service client; the caller names why
  input:    SealInput,
): Promise<SealResult> {
  if (!hasOrgPrefix(input.storagePath, input.orgId)) {
    reportError(new Error('evidence seal refused: path outside org prefix'), {
      site: 'lib.evidence.seal.badPath', orgId: input.orgId,
    })
    return { ok: false, reason: 'bad_path' }
  }

  const { data: blob, error: dlErr } = await supabase.storage
    .from(input.bucket)
    .download(input.storagePath, {}, { signal: AbortSignal.timeout(EVIDENCE_OBJECT_TIMEOUT_MS) })
  if (dlErr || !blob) {
    reportError(dlErr ?? new Error('evidence object missing'), {
      site: 'lib.evidence.seal.download', orgId: input.orgId,
    })
    return { ok: false, reason: 'object_missing' }
  }

  const bytes       = await blob.arrayBuffer()
  const storedHash  = sha256Of(bytes)
  const hashVerified = input.claimedSha256 !== null && input.claimedSha256 === storedHash
  if (input.claimedSha256 !== null && !hashVerified) {
    // Not an error for the crew member; a finding for us.
    reportError(new Error('evidence seal: stored bytes do not match claimed hash'), {
      site: 'lib.evidence.seal.hashMismatch', orgId: input.orgId,
      extra: { source_table: input.sourceTable, source_id: input.sourceId },
    })
  }

  const timing = timingFor(input, Date.now())

  const row = {
    org_id:                      input.orgId,
    property_id:                 input.propertyId,
    kind:                        'photo_sealed' as const,
    source_table:                input.sourceTable,
    source_id:                   input.sourceId,
    bucket:                      input.bucket,
    storage_path:                input.storagePath,
    sha256:                      storedHash,
    byte_size:                   input.byteSize ?? bytes.byteLength,
    hash_verified:               hashVerified,
    captured_at:                 timing.capturedAt,
    captured_at_source:          timing.source,
    device_captured_at:          timing.source === 'device' ? input.deviceCapturedAt : null,
    device_clock_offset_seconds: timing.offsetSeconds,
    lat:                         input.lat,
    lng:                         input.lng,
    gps_accuracy_m:              input.gpsAccuracyM,
    captured_by_kind:            input.capturedBy.kind,
    captured_by_id:              input.capturedBy.id,
    captured_by_label:           input.capturedBy.label,
    turnover_id:                 input.turnoverId,
    work_order_id:               input.workOrderId,
    inspection_id:               input.inspectionId,
    metadata:                    { ...(input.metadata ?? {}), claimed_sha256: input.claimedSha256 },
  }

  const { data: inserted, error: insErr } = await supabase
    .from('evidence_events')
    .insert(row)
    .select('id')
    .single()

  if (insErr) {
    const replay = insErr.code === '23505' ? await recoverReplay(supabase, input) : null
    if (replay) return replay
    reportError(insErr, { site: 'lib.evidence.seal.insert', orgId: input.orgId })
    return { ok: false, reason: 'insert_failed' }
  }

  await bracketEvidenceEvent(supabase, { orgId: input.orgId, eventId: inserted.id })
  return { ok: true, eventId: inserted.id, duplicate: false, hashVerified }
}
