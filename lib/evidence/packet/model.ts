// lib/evidence/packet/model.ts
//
// Everything a claim packet says, loaded and shaped, with no pdf-lib in sight.
// The renderer (./render.ts) draws this and nothing else.
//
// Runs in the evidence-packet Inngest function on the SERVICE client, so every
// read below carries .eq('org_id', ...) itself. The booking id arrives from a
// PM action that already verified it belongs to the caller's org and property;
// the org scope here is the second wall.
//
// GUEST IDENTITY: the cover page carries the platform reservation reference and
// the stay dates, never the guest's name or email. `guest_pii_anonymized_at`
// exists because guest PII is purged on a schedule, and a packet must still make
// sense after that has happened.
import 'server-only'
import { chunkArray, IN_CLAUSE_CHUNK_SIZE } from '@/lib/inngest/chunk'
import { unwrap, unwrapList } from '@/lib/supabase/unwrap'
import type { DBClient } from '@/lib/supabase/server'
import type { EvidenceBracketPosition } from '@/types/database'
import {
  applyPhotoCap, capNote, pairByRoom, type PacketEvent, type RoomPair,
} from './pairing'

export const PACKET_POSITIONS: readonly EvidenceBracketPosition[] = ['pre_stay', 'post_stay']

/** A bracket row never has more than a few hundred events; this bounds the read, not the document. */
const MAX_BRACKET_ROWS = 2_000

const PACKET_EVENT_COLUMNS =
  'id, kind, bucket, storage_path, sha256, hash_verified, byte_size, captured_at, captured_at_source, '
  + 'device_captured_at, device_clock_offset_seconds, received_at, lat, lng, gps_accuracy_m, '
  + 'captured_by_kind, captured_by_label, refers_to_event_id, metadata'

export interface CustodyRow {
  id:                          string
  kind:                        'photo_sealed' | 'photo_withdrawn'
  position:                    EvidenceBracketPosition | null
  sha256:                      string
  hash_verified:               boolean
  captured_at:                 string
  captured_at_source:          'server' | 'device'
  device_captured_at:          string | null
  device_clock_offset_seconds: number | null
  received_at:                 string
  captured_by:                 string
  /** Photograph shown in the body, or only cited here (retake, over the cap, withdrawn). */
  disposition:                 'shown' | 'retake' | 'over_cap' | 'withdrawn'
}

export interface PacketModel {
  packetId:    string
  generatedAt: string
  org:         { name: string }
  property:    { name: string; address: string | null; timezone: string }
  stay:        { bookingId: string; checkin: string; checkout: string; source: string | null; reservationRef: string }
  pairs:       RoomPair[]
  others:      PacketEvent[]
  omittedCount: number
  capNote:     string | null
  custody:     CustodyRow[]
}

interface RawEvent {
  id:                          string
  kind:                        'photo_sealed' | 'photo_withdrawn'
  bucket:                      string
  storage_path:                string
  sha256:                      string
  hash_verified:               boolean
  byte_size:                   number | null
  captured_at:                 string
  captured_at_source:          'server' | 'device'
  device_captured_at:          string | null
  device_clock_offset_seconds: number | null
  received_at:                 string
  lat:                         number | null
  lng:                         number | null
  gps_accuracy_m:              number | null
  captured_by_kind:            PacketEvent['captured_by_kind']
  captured_by_label:           string | null
  refers_to_event_id:          string | null
  metadata:                    unknown
}

function metaString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const v = (metadata as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function toPacketEvent(raw: RawEvent, position: EvidenceBracketPosition): PacketEvent {
  return {
    id: raw.id, storage_path: raw.storage_path, bucket: raw.bucket, sha256: raw.sha256,
    hash_verified: raw.hash_verified, byte_size: raw.byte_size, captured_at: raw.captured_at,
    captured_at_source: raw.captured_at_source, device_captured_at: raw.device_captured_at,
    device_clock_offset_seconds: raw.device_clock_offset_seconds, received_at: raw.received_at,
    lat: raw.lat, lng: raw.lng, gps_accuracy_m: raw.gps_accuracy_m,
    captured_by_kind: raw.captured_by_kind, captured_by_label: raw.captured_by_label,
    section_name: metaString(raw.metadata, 'section_name'),
    evidence_role: metaString(raw.metadata, 'evidence_role'),
    evidence_spot_id: metaString(raw.metadata, 'evidence_spot_id'),
    position,
  }
}

async function loadRawEvents(supabase: DBClient, orgId: string, ids: readonly string[], kind: RawEvent['kind']): Promise<RawEvent[]> {
  const out: RawEvent[] = []
  for (const chunk of chunkArray(ids, IN_CLAUSE_CHUNK_SIZE)) {
    const res = await supabase
      .from('evidence_events')
      .select(PACKET_EVENT_COLUMNS)
      .eq('org_id', orgId)
      .eq('kind', kind)
      .in('id', chunk)
      .limit(chunk.length)
    out.push(...(unwrapList(res, { site: 'lib.evidence.packet.events', orgId }) as unknown as RawEvent[]))
  }
  return out
}

async function loadWithdrawals(supabase: DBClient, orgId: string, citedIds: readonly string[]): Promise<RawEvent[]> {
  const out: RawEvent[] = []
  for (const chunk of chunkArray(citedIds, IN_CLAUSE_CHUNK_SIZE)) {
    const res = await supabase
      .from('evidence_events')
      .select(PACKET_EVENT_COLUMNS)
      .eq('org_id', orgId)
      .eq('kind', 'photo_withdrawn')
      .in('refers_to_event_id', chunk)
      .limit(chunk.length)
    out.push(...(unwrapList(res, { site: 'lib.evidence.packet.withdrawals', orgId }) as unknown as RawEvent[]))
  }
  return out
}

function describeCapturer(kind: string, label: string | null): string {
  return label ? `${kind} (${label})` : kind
}

function custodyRow(raw: RawEvent, position: EvidenceBracketPosition | null, disposition: CustodyRow['disposition']): CustodyRow {
  return {
    id: raw.id, kind: raw.kind, position, sha256: raw.sha256, hash_verified: raw.hash_verified,
    captured_at: raw.captured_at, captured_at_source: raw.captured_at_source,
    device_captured_at: raw.device_captured_at, device_clock_offset_seconds: raw.device_clock_offset_seconds,
    received_at: raw.received_at, captured_by: describeCapturer(raw.captured_by_kind, raw.captured_by_label),
    disposition,
  }
}

/** The PM's own words for each claim spot ("Oven interior, door open"), instead of a bare "Claim spot". */
async function withSpotLabels(
  supabase: DBClient, orgId: string, propertyId: string, pairs: readonly RoomPair[],
): Promise<RoomPair[]> {
  const spotIds = new Set(pairs.flatMap((p) => [p.before?.evidence_spot_id, p.after?.evidence_spot_id]).filter((x): x is string => !!x))
  if (spotIds.size === 0) return [...pairs]
  const res = await supabase
    .from('property_evidence_spots')
    .select('id, label')
    .eq('org_id', orgId)
    .eq('property_id', propertyId)
    .limit(200)
  const labels = new Map(unwrapList(res, { site: 'lib.evidence.packet.spotLabels', orgId }).map((r) => [r.id, r.label]))
  return pairs.map((p) => {
    const id = p.before?.evidence_spot_id ?? p.after?.evidence_spot_id
    return id && labels.has(id) ? { ...p, label: labels.get(id)! } : p
  })
}

export interface LoadPacketInput {
  orgId:     string
  bookingId: string
  packetId:  string
  /** Restrict to these events (the PM's selection). Ids not bracketed to this booking are ignored. */
  eventIds:  readonly string[] | null
  nowMs:     number
}

export async function loadPacketModel(supabase: DBClient, input: LoadPacketInput): Promise<PacketModel | null> {
  const { orgId, bookingId } = input

  const bookingRes = await supabase
    .from('bookings')
    .select('id, property_id, checkin_date, checkout_date, source, external_id')
    .eq('org_id', orgId)
    .eq('id', bookingId)
    .maybeSingle()
  const booking = unwrap(bookingRes, { site: 'lib.evidence.packet.booking', orgId })
  if (!booking) return null

  const [property, org] = await Promise.all([
    supabase.from('properties').select('name, address, city, state, timezone')
      .eq('org_id', orgId).eq('id', booking.property_id).maybeSingle(),
    supabase.from('organizations').select('name').eq('id', orgId).maybeSingle(),
  ])
  const prop = unwrap(property, { site: 'lib.evidence.packet.property', orgId })
  const orgRow = unwrap(org, { site: 'lib.evidence.packet.org', orgId })
  if (!prop) return null

  const bracketRes = await supabase
    .from('evidence_stay_brackets')
    .select('evidence_event_id, position')
    .eq('org_id', orgId)
    .eq('booking_id', bookingId)
    .in('position', PACKET_POSITIONS as EvidenceBracketPosition[])
    .limit(MAX_BRACKET_ROWS)
  const brackets = unwrapList(bracketRes, { site: 'lib.evidence.packet.brackets', orgId })
  const positionOf = new Map(brackets.map((b) => [b.evidence_event_id, b.position as EvidenceBracketPosition]))

  const wanted = input.eventIds ? input.eventIds.filter((id) => positionOf.has(id)) : [...positionOf.keys()]
  const raws = await loadRawEvents(supabase, orgId, wanted, 'photo_sealed')
  const withdrawals = await loadWithdrawals(supabase, orgId, raws.map((r) => r.id))
  const withdrawnIds = new Set(withdrawals.map((w) => w.refers_to_event_id).filter((x): x is string => x !== null))

  // A withdrawn photo is cited, never drawn.
  const live = raws.filter((r) => !withdrawnIds.has(r.id))
  const events = live.map((r) => toPacketEvent(r, positionOf.get(r.id)!))
  const paired = pairByRoom(events)
  const capped = applyPhotoCap(paired)

  const pairs = await withSpotLabels(supabase, orgId, booking.property_id, capped.pairs)

  const retakeIds  = new Set(paired.retakes.map((e) => e.id))
  const omittedIds = new Set(capped.omitted.map((e) => e.id))
  const custody: CustodyRow[] = [
    ...raws.map((r) => {
      if (withdrawnIds.has(r.id)) return custodyRow(r, positionOf.get(r.id) ?? null, 'withdrawn')
      if (retakeIds.has(r.id))    return custodyRow(r, positionOf.get(r.id) ?? null, 'retake')
      if (omittedIds.has(r.id))   return custodyRow(r, positionOf.get(r.id) ?? null, 'over_cap')
      return custodyRow(r, positionOf.get(r.id) ?? null, 'shown')
    }),
    ...withdrawals.map((w) => custodyRow(w, null, 'withdrawn')),
  ].sort((a, b) => a.captured_at.localeCompare(b.captured_at))

  const address = [prop.address, prop.city, prop.state].filter(Boolean).join(', ')
  const ref = booking.external_id?.trim()
  return {
    packetId:    input.packetId,
    generatedAt: new Date(input.nowMs).toISOString(),
    org:         { name: orgRow?.name ?? '' },
    property:    { name: prop.name, address: address || null, timezone: prop.timezone },
    stay: {
      bookingId, checkin: booking.checkin_date, checkout: booking.checkout_date, source: booking.source,
      reservationRef: ref && ref.length > 0 ? ref : `Not recorded (booking ${bookingId.slice(0, 8)})`,
    },
    pairs, others: capped.others,
    omittedCount: capped.omitted.length,
    capNote: capNote(capped.omitted.length),
    custody,
  }
}
