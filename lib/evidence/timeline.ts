// lib/evidence/timeline.ts
//
// Read-side helpers for the PM evidence timeline (/properties/[id]/evidence).
// Pure where it can be; the loaders take the caller's RLS client, so every read
// is org-scoped twice (policy plus the explicit .eq('org_id')).
import { mapInChunks } from '@/lib/inngest/chunk'
import { unwrapList } from '@/lib/supabase/unwrap'
import type { DBClient } from '@/lib/supabase/server'
import type { EvidenceBracketPosition, EvidenceEvent } from '@/types/database'

export const MAX_STAYS            = 400
export const MAX_EVENTS_PER_STAY  = 300
export const MAX_UNBRACKETED      = 200
export const UNBRACKETED_DAYS     = 90

export type TimelineEvent = Pick<
  EvidenceEvent,
  'id' | 'kind' | 'bucket' | 'storage_path' | 'captured_at' | 'captured_at_source' | 'hash_verified'
  | 'captured_by_kind' | 'captured_by_label' | 'lat' | 'lng' | 'refers_to_event_id' | 'metadata'
>

export const TIMELINE_EVENT_COLUMNS =
  'id, kind, bucket, storage_path, captured_at, captured_at_source, hash_verified, captured_by_kind, captured_by_label, lat, lng, refers_to_event_id, metadata'

export interface StayBracketCounts { pre_stay: number; during_stay: number; post_stay: number }

export function emptyCounts(): StayBracketCounts {
  return { pre_stay: 0, during_stay: 0, post_stay: 0 }
}

interface BracketRow { booking_id: string; evidence_event_id: string; position: EvidenceBracketPosition }

export function loadBracketsForBookings(
  supabase: DBClient,
  orgId:    string,
  bookingIds: readonly string[],
): Promise<BracketRow[]> {
  return mapInChunks(bookingIds, async (chunk) => {
    const res = await supabase
      .from('evidence_stay_brackets')
      .select('booking_id, evidence_event_id, position')
      .eq('org_id', orgId)
      .in('booking_id', chunk)
      .limit(chunk.length * MAX_EVENTS_PER_STAY)
    return (unwrapList(res, { site: 'lib.evidence.timeline.brackets', orgId }) ?? []) as BracketRow[]
  })
}

export function countByBooking(rows: readonly BracketRow[]): Map<string, StayBracketCounts> {
  const map = new Map<string, StayBracketCounts>()
  for (const r of rows) {
    const c = map.get(r.booking_id) ?? emptyCounts()
    c[r.position] += 1
    map.set(r.booking_id, c)
  }
  return map
}

export async function loadEventsByIds(
  supabase: DBClient,
  orgId:    string,
  eventIds: readonly string[],
): Promise<TimelineEvent[]> {
  const out = await mapInChunks(eventIds, async (chunk) => {
    const res = await supabase
      .from('evidence_events')
      .select(TIMELINE_EVENT_COLUMNS)
      .eq('org_id', orgId)
      .in('id', chunk)
      .order('captured_at', { ascending: true })
      .limit(chunk.length)
    return (unwrapList(res, { site: 'lib.evidence.timeline.events', orgId }) ?? []) as TimelineEvent[]
  })
  return out.sort((a, b) => a.captured_at.localeCompare(b.captured_at))
}

/** Ids of the originals that a photo_withdrawn row points at. */
export async function loadWithdrawnOriginalIds(
  supabase: DBClient,
  orgId:    string,
  eventIds: readonly string[],
): Promise<Set<string>> {
  const rows = await mapInChunks(eventIds, async (chunk) => {
    const res = await supabase
      .from('evidence_events')
      .select('refers_to_event_id')
      .eq('org_id', orgId)
      .eq('kind', 'photo_withdrawn')
      .in('refers_to_event_id', chunk)
      .limit(chunk.length)
    return unwrapList(res, { site: 'lib.evidence.timeline.withdrawn', orgId }) ?? []
  })
  const withdrawn = new Set<string>()
  for (const r of rows) {
    if (r.refers_to_event_id) withdrawn.add(r.refers_to_event_id)
  }
  return withdrawn
}

/** Sealed photos in the last UNBRACKETED_DAYS days that no stay claims. */
export async function loadUnbracketedEvents(
  supabase:   DBClient,
  orgId:      string,
  propertyId: string,
  nowMs:      number,
): Promise<TimelineEvent[]> {
  const since = new Date(nowMs - UNBRACKETED_DAYS * 86_400_000).toISOString()
  const res = await supabase
    .from('evidence_events')
    .select(TIMELINE_EVENT_COLUMNS)
    .eq('org_id', orgId)
    .eq('property_id', propertyId)
    .eq('kind', 'photo_sealed')
    .gte('captured_at', since)
    .order('captured_at', { ascending: false })
    .limit(MAX_UNBRACKETED)
  const events = (unwrapList(res, { site: 'lib.evidence.timeline.unbracketed', orgId }) ?? []) as TimelineEvent[]
  if (events.length === 0) return []

  const claims = await mapInChunks(events.map((e) => e.id), async (chunk) => {
    const b = await supabase
      .from('evidence_stay_brackets')
      .select('evidence_event_id')
      .eq('org_id', orgId)
      .in('evidence_event_id', chunk)
      .limit(chunk.length * 4)
    return unwrapList(b, { site: 'lib.evidence.timeline.unbracketedClaims', orgId }) ?? []
  })
  const claimed = new Set(claims.map((r) => r.evidence_event_id))
  return events.filter((e) => !claimed.has(e.id))
}

export function formatInTimezone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return new Date(iso).toISOString()
  }
}

/** Wall clock, isolated so a Server Component can read it without calling Date.now() in render. */
export function currentTimeMs(): number {
  return Date.now()
}
