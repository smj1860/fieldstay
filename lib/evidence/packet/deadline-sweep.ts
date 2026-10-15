// lib/evidence/packet/deadline-sweep.ts
//
// Decides which guest stays have a claim countdown running and which
// notification each one is owed today. Reads only; the Inngest function
// (lib/inngest/functions/evidence-deadlines.ts) writes the notifications.
//
// WHAT OPENS A COUNTDOWN. A stay is a candidate only when something went wrong
// on it: its turnover was flagged, or a crew_flag work order was raised against
// it. Every completed turnover seals "after" photos, so keying the countdown on
// sealing alone would put a deadline notice in front of the PM for every
// Airbnb and VRBO stay they host. The countdown is for stays with a reason to
// file.
//
// The stay is the DEPARTING guest's: on a pair turnover (prev_booking_id set)
// that is prev_booking_id; on a standalone turnover it is booking_id (see
// lib/evidence/bracket.ts for the same flip).
import 'server-only'
import { chunkArray, IN_CLAUSE_CHUNK_SIZE } from '@/lib/inngest/chunk'
import { unwrap, unwrapList } from '@/lib/supabase/unwrap'
import type { DBClient } from '@/lib/supabase/server'
import type { CreatePmNotificationInput } from '@/lib/inngest/helpers'
import {
  claimDeadline, daysBetween, deadlineDedupeKey, deadlineNotice, localDate, stageFor,
} from './deadlines'

/** How far back a flagged turnover can still be a live claim. Past every platform window plus slack. */
export const DEADLINE_LOOKBACK_DAYS = 45
const MAX_CANDIDATE_TURNOVERS = 500

interface TurnoverRow {
  id:               string
  property_id:      string
  booking_id:       string | null
  prev_booking_id:  string | null
  checkin_datetime: string
}
interface BookingRow { id: string; source: string | null; checkout_date: string }
interface PropertyRow { id: string; name: string; timezone: string }

async function candidateTurnoverIds(
  supabase: DBClient, orgId: string, sinceIso: string, only: string | null,
): Promise<string[]> {
  if (only) return [only]
  const flagged = await supabase
    .from('turnovers').select('id')
    .eq('org_id', orgId).eq('status', 'flagged').gte('checkout_datetime', sinceIso)
    .limit(MAX_CANDIDATE_TURNOVERS)
  const crewFlag = await supabase
    .from('work_orders').select('source_turnover_id')
    .eq('org_id', orgId).eq('source', 'crew_flag').not('source_turnover_id', 'is', null).gte('created_at', sinceIso)
    .limit(MAX_CANDIDATE_TURNOVERS)
  const ids = new Set<string>(unwrapList(flagged, { site: 'lib.evidence.deadlines.flagged', orgId }).map((r) => r.id))
  for (const r of unwrapList(crewFlag, { site: 'lib.evidence.deadlines.crewFlag', orgId })) {
    if (r.source_turnover_id) ids.add(r.source_turnover_id)
  }
  return [...ids]
}

async function loadTurnovers(supabase: DBClient, orgId: string, ids: readonly string[]): Promise<TurnoverRow[]> {
  const out: TurnoverRow[] = []
  for (const chunk of chunkArray(ids, IN_CLAUSE_CHUNK_SIZE)) {
    const res = await supabase
      .from('turnovers').select('id, property_id, booking_id, prev_booking_id, checkin_datetime')
      .eq('org_id', orgId).in('id', chunk).limit(chunk.length)
    out.push(...unwrapList(res, { site: 'lib.evidence.deadlines.turnovers', orgId }))
  }
  return out
}

async function loadBookings(supabase: DBClient, orgId: string, ids: readonly string[]): Promise<Map<string, BookingRow>> {
  const out = new Map<string, BookingRow>()
  for (const chunk of chunkArray(ids, IN_CLAUSE_CHUNK_SIZE)) {
    const res = await supabase
      .from('bookings').select('id, source, checkout_date')
      .eq('org_id', orgId).in('id', chunk).limit(chunk.length)
    for (const b of unwrapList(res, { site: 'lib.evidence.deadlines.bookings', orgId })) out.set(b.id, b)
  }
  return out
}

async function loadProperties(supabase: DBClient, orgId: string, ids: readonly string[]): Promise<Map<string, PropertyRow>> {
  const out = new Map<string, PropertyRow>()
  for (const chunk of chunkArray(ids, IN_CLAUSE_CHUNK_SIZE)) {
    const res = await supabase
      .from('properties').select('id, name, timezone')
      .eq('org_id', orgId).in('id', chunk).limit(chunk.length)
    for (const p of unwrapList(res, { site: 'lib.evidence.deadlines.properties', orgId })) out.set(p.id, p)
  }
  return out
}

export async function sweepOrgDeadlines(
  supabase: DBClient,
  input: { orgId: string; nowMs: number; onlyTurnoverId?: string | null },
): Promise<CreatePmNotificationInput[]> {
  const { orgId, nowMs } = input
  const since = new Date(nowMs - DEADLINE_LOOKBACK_DAYS * 86_400_000).toISOString()

  const orgRes = await supabase.from('organizations').select('claim_window_days').eq('id', orgId).maybeSingle()
  const claimWindowDays = unwrap(orgRes, { site: 'lib.evidence.deadlines.org', orgId })?.claim_window_days ?? 14

  const turnoverIds = await candidateTurnoverIds(supabase, orgId, since, input.onlyTurnoverId ?? null)
  if (turnoverIds.length === 0) return []
  const turnovers = await loadTurnovers(supabase, orgId, turnoverIds)

  const departingId = (t: TurnoverRow) => t.prev_booking_id ?? t.booking_id
  const bookings = await loadBookings(supabase, orgId, [...new Set(turnovers.map(departingId).filter((x): x is string => !!x))])
  const properties = await loadProperties(supabase, orgId, [...new Set(turnovers.map((t) => t.property_id))])

  const out: CreatePmNotificationInput[] = []
  const seen = new Set<string>()
  for (const t of turnovers) {
    const bookingId = departingId(t)
    const booking = bookingId ? bookings.get(bookingId) : undefined
    const property = properties.get(t.property_id)
    if (!bookingId || !booking || !property || seen.has(bookingId)) continue
    seen.add(bookingId)

    const today = localDate(nowMs, property.timezone)
    if (booking.checkout_date > today) continue   // the guest has not left yet

    // A pair turnover's check-in is the ARRIVING guest's; a standalone one has none to bound by.
    const nextCheckinDate = t.prev_booking_id ? localDate(Date.parse(t.checkin_datetime), property.timezone) : null
    const deadline = claimDeadline({ source: booking.source, checkoutDate: booking.checkout_date, nextCheckinDate, claimWindowDays })
    const daysLeft = daysBetween(today, deadline.deadlineDate)
    const stage = stageFor(daysLeft)
    const notice = deadlineNotice({ stage, propertyName: property.name, deadlineDate: deadline.deadlineDate, daysLeft, basis: deadline.basis })

    out.push({
      orgId,
      type:      'evidence_claim_deadline',
      title:     notice.title,
      subtitle:  notice.subtitle,
      href:      `/properties/${property.id}/evidence?stay=${bookingId}`,
      severity:  notice.severity,
      dedupeKey: deadlineDedupeKey(bookingId, stage),
    })
  }
  return out
}
