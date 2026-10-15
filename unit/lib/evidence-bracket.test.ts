import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveBrackets, bracketEvidenceEvent, type BracketBooking } from '@/lib/evidence/bracket'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

type Reply = { data: unknown; error: { message: string } | null }

/** Chainable fake: every builder method returns itself; awaiting yields the next reply queued for the table. */
function fakeDb(replies: Record<string, Reply[]>): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {}
    const next = () => (replies[table]?.shift() ?? { data: null, error: null })
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'limit', 'delete', 'upsert']) chain[m] = () => chain
    chain.maybeSingle = async () => next()
    chain.then = (res: (v: Reply) => unknown) => Promise.resolve(next()).then(res)
    return chain
  }
  return { from } as unknown as SupabaseClient
}

const EV: Reply = { data: { id: 'e1', org_id: 'o', property_id: 'p', captured_at: '2026-10-10T15:00:00Z', turnover_id: 't1' }, error: null }

// Owner stays and blocks are filtered by the CALLER (bracketEvidenceEvent's
// query), not by resolveBrackets, so they are never passed in here.
const stay = (id: string, checkin: string, checkout: string): BracketBooking =>
  ({ id, checkin_date: checkin, checkout_date: checkout })

describe('resolveBrackets', () => {
  it('pair turnover brackets post_stay of the departing and pre_stay of the arriving booking', () => {
    expect(resolveBrackets({
      capturedAt: '2026-10-10T15:00:00Z',
      turnover: { booking_id: 'next', prev_booking_id: 'prev' },
      bookings: [],
    })).toEqual([
      { booking_id: 'prev', position: 'post_stay' },
      { booking_id: 'next', position: 'pre_stay' },
    ])
  })

  it('standalone turnover brackets post_stay of booking_id', () => {
    expect(resolveBrackets({
      capturedAt: '2026-10-10T15:00:00Z',
      turnover: { booking_id: 'b1', prev_booking_id: null },
      bookings: [],
    })).toEqual([{ booking_id: 'b1', position: 'post_stay' }])
  })

  it('no turnover inside a stay is during_stay', () => {
    expect(resolveBrackets({
      capturedAt: '2026-10-11T12:00:00Z', turnover: null,
      bookings: [stay('s1', '2026-10-09', '2026-10-13')],
    })).toEqual([{ booking_id: 's1', position: 'during_stay' }])
  })

  it('no turnover between stays gives post_stay of prior and pre_stay of next', () => {
    expect(resolveBrackets({
      capturedAt: '2026-10-13T12:00:00Z', turnover: null,
      bookings: [stay('prior', '2026-10-08', '2026-10-10'), stay('next', '2026-10-18', '2026-10-20')],
    })).toEqual([
      { booking_id: 'prior', position: 'post_stay' },
      { booking_id: 'next',  position: 'pre_stay' },
    ])
  })

  it('nothing within 14 days gives no brackets', () => {
    expect(resolveBrackets({
      capturedAt: '2026-10-13T12:00:00Z', turnover: null,
      bookings: [stay('old', '2026-09-01', '2026-09-10'), stay('far', '2026-11-20', '2026-11-25')],
    })).toEqual([])
  })
})

describe('resolveBrackets guest-stay eligibility on turnovers', () => {
  const pair = { booking_id: 'next', prev_booking_id: 'prev' }
  it('drops a side that is an owner stay or block', () => {
    expect(resolveBrackets({
      capturedAt: '2026-10-10T15:00:00Z', turnover: pair, bookings: [],
      eligibleBookingIds: new Set(['next']),
    })).toEqual([{ booking_id: 'next', position: 'pre_stay' }])
  })
  it('brackets nothing when neither side is a guest stay', () => {
    expect(resolveBrackets({
      capturedAt: '2026-10-10T15:00:00Z', turnover: pair, bookings: [], eligibleBookingIds: new Set(),
    })).toEqual([])
  })
})

describe('bracketEvidenceEvent results', () => {
  it('returns db_error rather than swallowing a failed read', async () => {
    const db = fakeDb({ evidence_events: [{ data: null, error: { message: 'boom' } }] })
    expect(await bracketEvidenceEvent(db, { orgId: 'o', eventId: 'e1' })).toEqual({ ok: false, reason: 'db_error' })
  })
  it('returns event_missing for an unknown event', async () => {
    const db = fakeDb({ evidence_events: [{ data: null, error: null }] })
    expect(await bracketEvidenceEvent(db, { orgId: 'o', eventId: 'e1' })).toEqual({ ok: false, reason: 'event_missing' })
  })
  it('brackets only the guest-stay side of a pair turnover', async () => {
    const db = fakeDb({
      evidence_events: [EV],
      turnovers: [{ data: { booking_id: 'next', prev_booking_id: 'owner' }, error: null }],
      bookings: [{ data: [{ id: 'next' }], error: null }, { data: [], error: null }],
    })
    expect(await bracketEvidenceEvent(db, { orgId: 'o', eventId: 'e1' })).toEqual({ ok: true, brackets: 1 })
  })
})
