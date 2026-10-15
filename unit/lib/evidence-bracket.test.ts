import { describe, it, expect } from 'vitest'
import { resolveBrackets, type BracketBooking } from '@/lib/evidence/bracket'

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
