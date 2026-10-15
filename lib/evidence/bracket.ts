// lib/evidence/bracket.ts
//
// Which stay(s) a piece of evidence speaks to, and from which side.
//
// Rules, in priority order:
//  1. Evidence tied to a PAIR turnover (prev_booking_id set) brackets two
//     stays: post_stay of prev_booking_id and pre_stay of booking_id.
//  2. Evidence tied to a STANDALONE turnover (prev_booking_id null) brackets
//     post_stay of booking_id, which on a standalone row is the DEPARTING
//     booking (see lib/turnovers/generator.ts: booking_id's meaning flips on
//     whether prev_booking_id is null).
//  3. Evidence with no turnover: a confirmed/tentative booking whose
//     [checkin_date, checkout_date) contains captured_at gives during_stay.
//     Otherwise the nearest booking that checked out within BRACKET_WINDOW_DAYS
//     before captured_at gives post_stay, and the nearest that checks in
//     within BRACKET_WINDOW_DAYS after gives pre_stay. Both may apply.
//  4. Nothing matches: no bracket rows. The evidence still exists; the
//     timeline shows it under the property, outside any stay.
//
// Owner stays (stay_type = 'owner_stay') and blocks (is_block) are NOT stays
// for this purpose: a damage claim is against a guest.
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'
import type { EvidenceBracketPosition } from '@/types/database'

export const BRACKET_WINDOW_DAYS = 14

export interface BracketTurnover {
  booking_id:      string | null
  prev_booking_id: string | null
}

export interface BracketBooking {
  id:            string
  checkin_date:  string   // YYYY-MM-DD
  checkout_date: string   // YYYY-MM-DD
}

export interface BracketDecision {
  booking_id: string
  position:   EvidenceBracketPosition
}

const DAY_MS = 86_400_000

function turnoverDecisions(turnover: BracketTurnover): BracketDecision[] {
  if (turnover.prev_booking_id && turnover.booking_id) {
    return [
      { booking_id: turnover.prev_booking_id, position: 'post_stay' },
      { booking_id: turnover.booking_id,      position: 'pre_stay'  },
    ]
  }
  if (turnover.booking_id) return [{ booking_id: turnover.booking_id, position: 'post_stay' }]
  return []
}

export function resolveBrackets(input: {
  capturedAt: string
  turnover:   BracketTurnover | null
  bookings:   readonly BracketBooking[]   // guest stays for the property, already filtered
  /**
   * Booking ids that ARE guest stays (not owner stays, blocks or cancelled).
   * A turnover names its bookings directly, so the window query's guest-stay
   * filter never applies to them: without this, an owner stay or a block on
   * either side of a pair turnover would be bracketed as a claimable stay.
   * Null skips the check (callers with no turnover).
   */
  eligibleBookingIds?: ReadonlySet<string> | null
}): BracketDecision[] {
  const { turnover, bookings } = input
  if (turnover) {
    const eligible = input.eligibleBookingIds
    return turnoverDecisions(turnover).filter((d) => !eligible || eligible.has(d.booking_id))
  }

  const t = Date.parse(input.capturedAt)
  if (Number.isNaN(t)) return []
  const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`)

  const during = bookings.find((b) => dayOf(b.checkin_date) <= t && t < dayOf(b.checkout_date))
  if (during) return [{ booking_id: during.id, position: 'during_stay' }]

  const out: BracketDecision[] = []
  const windowMs = BRACKET_WINDOW_DAYS * DAY_MS

  const prior = bookings
    .filter((b) => dayOf(b.checkout_date) <= t && t - dayOf(b.checkout_date) <= windowMs)
    .sort((a, b) => dayOf(b.checkout_date) - dayOf(a.checkout_date))[0]
  if (prior) out.push({ booking_id: prior.id, position: 'post_stay' })

  const next = bookings
    .filter((b) => dayOf(b.checkin_date) > t && dayOf(b.checkin_date) - t <= windowMs)
    .sort((a, b) => dayOf(a.checkin_date) - dayOf(b.checkin_date))[0]
  if (next) out.push({ booking_id: next.id, position: 'pre_stay' })

  return out
}

export type BracketResult =
  | { ok: true;  brackets: number }
  | { ok: false; reason: 'event_missing' | 'db_error' }

/** Guest-stay booking ids among the ones a turnover names. */
async function eligibleTurnoverBookings(
  supabase: SupabaseClient, orgId: string, turnover: BracketTurnover,
): Promise<ReadonlySet<string> | 'db_error'> {
  const ids = [turnover.prev_booking_id, turnover.booking_id].filter((x): x is string => !!x)
  if (ids.length === 0) return new Set()
  const { data, error } = await supabase
    .from('bookings')
    .select('id')
    .eq('org_id', orgId)
    .in('id', ids)
    .eq('is_block', false)
    .eq('stay_type', 'guest_stay')
    .in('status', ['confirmed', 'tentative'])
    .limit(ids.length)
  if (error) {
    reportError(error, { site: 'lib.evidence.bracket.eligible', orgId })
    return 'db_error'
  }
  return new Set((data ?? []).map((b) => b.id))
}

/**
 * Recomputes and REPLACES the bracket rows for one evidence event. Idempotent:
 * delete-then-insert of a derived set, keyed on the event id.
 *
 * RETURNS a result rather than void: every database failure used to be reported
 * and swallowed, so the Inngest caller finished "ok" and a failed bracket was
 * never retried. Callers that can retry (the re-bracket job) throw on db_error.
 */
export async function bracketEvidenceEvent(
  supabase: SupabaseClient,   // service client
  input: { orgId: string; eventId: string },
): Promise<BracketResult> {
  const { data: ev, error: evErr } = await supabase
    .from('evidence_events')
    .select('id, org_id, property_id, captured_at, turnover_id')
    .eq('id', input.eventId)
    .eq('org_id', input.orgId)
    .maybeSingle()
  if (evErr) {
    reportError(evErr, { site: 'lib.evidence.bracket.loadEvent', orgId: input.orgId })
    return { ok: false, reason: 'db_error' }
  }
  if (!ev) return { ok: false, reason: 'event_missing' }

  let turnover: BracketTurnover | null = null
  let eligible: ReadonlySet<string> | null = null
  if (ev.turnover_id) {
    const { data: t, error: tErr } = await supabase
      .from('turnovers')
      .select('booking_id, prev_booking_id')
      .eq('id', ev.turnover_id)
      .eq('org_id', input.orgId)
      .maybeSingle()
    if (tErr) {
      reportError(tErr, { site: 'lib.evidence.bracket.loadTurnover', orgId: input.orgId })
      return { ok: false, reason: 'db_error' }
    }
    turnover = t ?? null
    if (turnover) {
      const found = await eligibleTurnoverBookings(supabase, input.orgId, turnover)
      if (found === 'db_error') return { ok: false, reason: 'db_error' }
      eligible = found
    }
  }

  // Bounded: one property, a 2-window span around the capture. A property
  // does not have 1000 bookings in 28 days.
  const t = Date.parse(ev.captured_at)
  const lo = new Date(t - BRACKET_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  const hi = new Date(t + BRACKET_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  const { data: bookings, error: bErr } = await supabase
    .from('bookings')
    .select('id, checkin_date, checkout_date')
    .eq('org_id', input.orgId)
    .eq('property_id', ev.property_id)
    .eq('is_block', false)
    .eq('stay_type', 'guest_stay')
    .in('status', ['confirmed', 'tentative'])
    .gte('checkout_date', lo)
    .lte('checkin_date', hi)
    .limit(200)
  if (bErr) {
    reportError(bErr, { site: 'lib.evidence.bracket.loadBookings', orgId: input.orgId })
    return { ok: false, reason: 'db_error' }
  }

  const decisions = resolveBrackets({
    capturedAt: ev.captured_at, turnover, bookings: bookings ?? [], eligibleBookingIds: eligible,
  })

  const { error: delErr } = await supabase
    .from('evidence_stay_brackets')
    .delete()
    .eq('org_id', input.orgId)
    .eq('evidence_event_id', ev.id)
  if (delErr) {
    reportError(delErr, { site: 'lib.evidence.bracket.clear', orgId: input.orgId })
    return { ok: false, reason: 'db_error' }
  }
  if (decisions.length === 0) return { ok: true, brackets: 0 }

  const { error: insErr } = await supabase
    .from('evidence_stay_brackets')
    .upsert(
      decisions.map((d) => ({
        org_id:            input.orgId,
        evidence_event_id: ev.id,
        booking_id:        d.booking_id,
        position:          d.position,
      })),
      { onConflict: 'evidence_event_id,booking_id', ignoreDuplicates: true },
    )
  if (insErr) {
    reportError(insErr, { site: 'lib.evidence.bracket.insert', orgId: input.orgId })
    return { ok: false, reason: 'db_error' }
  }
  return { ok: true, brackets: decisions.length }
}
