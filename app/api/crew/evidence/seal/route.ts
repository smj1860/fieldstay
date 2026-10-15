import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember, type CrewAuthContext } from '@/lib/crew-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { checkLimit, retryAfterSeconds, evidenceSealRatelimit } from '@/lib/rate-limit'
import { unwrap } from '@/lib/supabase/unwrap'
import { logAuditEvent } from '@/lib/audit'
import { sealPhoto } from '@/lib/evidence/seal'
import { pathMatchesTarget, type CrewSealTarget } from '@/lib/evidence/seal-paths'
import type { EvidenceSourceTable } from '@/types/database'

/**
 * Crew-side seal for a photo the outbox already uploaded to turnover-photos.
 *
 * Trust boundary: the client supplies a hash, a device clock and a target row.
 * This route trusts NONE of it. The org comes from the session; the property
 * and turnover come from the target row, which must belong to that org; the
 * path must sit under the org prefix; the hash is recomputed from the stored
 * object. The client's numbers are recorded as claims next to the server's
 * findings, which is the whole point of a ledger.
 */

const CREW_SOURCE_TABLES = new Set<EvidenceSourceTable>([
  'checklist_instance_items', 'checklist_instances', 'property_assets',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA_RE  = /^[0-9a-f]{64}$/

interface SealBody {
  client_seal_id: string
  bucket:         'turnover-photos'
  storage_path:   string
  sha256:         string
  byte_size:      number | null
  captured_at:    string
  device_now:     string
  lat:            number | null
  lng:            number | null
  gps_accuracy_m: number | null
  source_table:   EvidenceSourceTable
  source_id:      string
  turnover_id:    string | null
}

type Parsed = { ok: true; value: SealBody } | { ok: false; response: NextResponse }

function bad(msg: string): Parsed {
  return { ok: false, response: NextResponse.json({ error: msg }, { status: 400 }) }
}

function optionalNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parseBody(raw: unknown): Parsed {
  if (!raw || typeof raw !== 'object') return bad('Invalid body')
  const b = raw as Record<string, unknown>
  if (typeof b.client_seal_id !== 'string' || !UUID_RE.test(b.client_seal_id)) return bad('Invalid client_seal_id')
  if (b.bucket !== 'turnover-photos') return bad('Invalid bucket')
  if (typeof b.storage_path !== 'string' || b.storage_path.length === 0 || b.storage_path.length > 512) return bad('Invalid storage_path')
  if (typeof b.sha256 !== 'string' || !SHA_RE.test(b.sha256)) return bad('Invalid sha256')
  if (typeof b.captured_at !== 'string' || Number.isNaN(Date.parse(b.captured_at))) return bad('Invalid captured_at')
  if (typeof b.device_now !== 'string' || Number.isNaN(Date.parse(b.device_now))) return bad('Invalid device_now')
  if (typeof b.source_table !== 'string' || !CREW_SOURCE_TABLES.has(b.source_table as EvidenceSourceTable)) return bad('Invalid source_table')
  if (typeof b.source_id !== 'string' || !UUID_RE.test(b.source_id)) return bad('Invalid source_id')
  const turnover_id = typeof b.turnover_id === 'string' && UUID_RE.test(b.turnover_id) ? b.turnover_id : null
  return {
    ok: true,
    value: {
      client_seal_id: b.client_seal_id,
      bucket:         'turnover-photos',
      storage_path:   b.storage_path,
      sha256:         b.sha256.toLowerCase(),
      byte_size:      optionalNumber(b.byte_size),
      captured_at:    b.captured_at,
      device_now:     b.device_now,
      lat:            optionalNumber(b.lat),
      lng:            optionalNumber(b.lng),
      gps_accuracy_m: optionalNumber(b.gps_accuracy_m),
      source_table:   b.source_table as EvidenceSourceTable,
      source_id:      b.source_id,
      turnover_id,
    },
  }
}

/**
 * The property (and turnover) the target row belongs to, resolved through the
 * crew member's RLS client so a row outside their assignments reads as "not
 * found". IDOR is answered by RLS plus the explicit org check, both.
 */
interface SealTarget {
  propertyId:     string
  turnoverId:     string | null
  evidenceRole?:  string | null
  evidenceSpotId?: string | null
  sectionName?:   string | null
}

async function resolveTarget(
  supabase: CrewAuthContext['supabase'],
  orgId:    string,
  body:     SealBody,
): Promise<SealTarget | null> {
  const site = 'route.crew.evidence.seal.resolveTarget'
  if (body.source_table === 'property_assets') {
    const res = await supabase.from('property_assets')
      .select('property_id, org_id').eq('id', body.source_id).eq('org_id', orgId).maybeSingle()
    const data = unwrap(res, { site, orgId })
    return data ? { propertyId: data.property_id, turnoverId: null } : null
  }
  if (body.source_table === 'checklist_instances') {
    const res = await supabase.from('checklist_instances')
      .select('turnover_id, org_id, turnovers!inner(property_id)').eq('id', body.source_id).eq('org_id', orgId).maybeSingle()
    const data = unwrap(res, { site, orgId })
    const pid = data?.turnovers?.property_id ?? null
    return data && pid ? { propertyId: pid, turnoverId: data.turnover_id } : null
  }
  const res = await supabase.from('checklist_instance_items')
    .select('turnover_id, evidence_role, evidence_spot_id, section_name, turnovers!inner(property_id, org_id)').eq('id', body.source_id).maybeSingle()
  const data = unwrap(res, { site, orgId })
  const t = data?.turnovers
  if (!data || !t || t.org_id !== orgId) return null
  return {
    propertyId: t.property_id, turnoverId: data.turnover_id,
    evidenceRole: data.evidence_role, evidenceSpotId: data.evidence_spot_id, sectionName: data.section_name,
  }
}

function sealTargetOf(orgId: string, body: SealBody, target: SealTarget): CrewSealTarget {
  if (body.source_table === 'property_assets') return { table: 'property_assets', orgId, propertyId: target.propertyId }
  if (body.source_table === 'checklist_instances') return { table: 'checklist_instances', orgId, turnoverId: target.turnoverId }
  return { table: 'checklist_instance_items', orgId, turnoverId: target.turnoverId, itemId: body.source_id }
}

export async function POST(request: NextRequest) {
  const parsed = parseBody(await request.json().catch(() => null))
  if (!parsed.ok) return parsed.response
  const body = parsed.value

  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { supabase, crew, user } = auth

  const decision = await checkLimit(evidenceSealRatelimit, crew.id, {
    onError: 'allow',   // a Redis outage must not block an outbox drain
    site:    'route.crew.evidence.seal.POST',
  })
  if (!decision.allowed) {
    return NextResponse.json({ error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(decision)) } })
  }

  const target = await resolveTarget(supabase, crew.org_id, body)
  if (!target) return NextResponse.json({ error: 'Target not found' }, { status: 404 })

  // The path is client-supplied. It must be one this target's own capture could
  // have produced, or a crew member could seal any photo in the org as evidence
  // for an item they can see. 400 is terminal: the outbox dead-letters it.
  if (!pathMatchesTarget(body.storage_path, sealTargetOf(crew.org_id, body, target))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  // A client-supplied turnover id is only a HINT; the target row is the truth.
  const turnoverId = target.turnoverId ?? body.turnover_id

  const service = createServiceClient({ crew })
  const result  = await sealPhoto(service, {
    orgId:            crew.org_id,
    propertyId:       target.propertyId,
    bucket:           body.bucket,
    storagePath:      body.storage_path,
    sourceTable:      body.source_table,
    sourceId:         body.source_id,
    claimedSha256:    body.sha256,
    byteSize:         body.byte_size,
    deviceCapturedAt: body.captured_at,
    deviceNow:        body.device_now,
    lat:              body.lat,
    lng:              body.lng,
    gpsAccuracyM:     body.gps_accuracy_m,
    capturedBy:       { kind: 'crew', id: crew.id, label: null },
    turnoverId,
    workOrderId:      null,
    inspectionId:     null,
    metadata: {
      client_seal_id:   body.client_seal_id,
      evidence_role:    target.evidenceRole ?? null,
      evidence_spot_id: target.evidenceSpotId ?? null,
      section_name:     target.sectionName ?? null,
    },
  })

  if (!result.ok) {
    // object_missing is retryable (the upload may still be propagating);
    // bad_path is terminal and means a client bug; insert_failed is a 5xx.
    if (result.reason === 'object_missing') return NextResponse.json({ error: 'Photo not found yet' }, { status: 503 })
    if (result.reason === 'bad_path')       return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  if (!result.duplicate) {
    await logAuditEvent({
      orgId:      crew.org_id,
      actorId:    user.id,
      action:     'evidence.photo_sealed',
      targetType: 'evidence_event',
      targetId:   result.eventId,
      dedupeKey:  `evidence-seal-${result.eventId}`,
      metadata:   { source_table: body.source_table, hash_verified: result.hashVerified },
    })
  }

  return NextResponse.json({ success: true, event_id: result.eventId, duplicate: result.duplicate, hash_verified: result.hashVerified })
}
