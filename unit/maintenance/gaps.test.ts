import { describe, it, expect } from 'vitest'
import { deriveVacancyGaps, monthBounds, pickVacantDayInMonth } from '@/lib/maintenance/gaps'

// ============================================================================
// VACANCY GAPS — the one derivation of "the property is empty".
//
// Two callers ask opposite questions of it. The Phase 18 cron asks the
// schedule-driven one (find the gaps, then see what maintenance falls inside);
// the inspection scheduler asks the inverse (given the month this occurrence is
// due, find a free day in it). They have to agree, which is why the derivation
// is one function and not two.
//
// The month boundary is not a detail. `calcNextDueDate` steps whole months from
// the previous due date, so the calendar month IS this codebase's recurrence
// anchor — there is no anchor column. A nudge that leaves the month silently
// re-anchors every occurrence after it.
// ============================================================================

const b = (checkin_date: string, checkout_date: string) => ({ checkin_date, checkout_date })

describe('deriveVacancyGaps', () => {
  it('finds the gap between two bookings', () => {
    expect(deriveVacancyGaps([b('2026-09-01', '2026-09-05'), b('2026-09-20', '2026-09-25')], 90))
      .toEqual([
        { start: '2026-09-05', end: '2026-09-20', days: 15 },
        { start: '2026-09-25', end: null,         days: 90 },
      ])
  })

  it('a back-to-back turnover is not a gap', () => {
    // Checkout and checkin on the same day: no free day at all between them.
    expect(deriveVacancyGaps([b('2026-09-01', '2026-09-05'), b('2026-09-05', '2026-09-09')], 30))
      .toEqual([{ start: '2026-09-09', end: null, days: 30 }])
  })

  it('sorts the input rather than trusting the caller ORDER BY', () => {
    const shuffled = deriveVacancyGaps([b('2026-09-20', '2026-09-25'), b('2026-09-01', '2026-09-05')], 90)
    const ordered  = deriveVacancyGaps([b('2026-09-01', '2026-09-05'), b('2026-09-20', '2026-09-25')], 90)
    expect(shuffled).toEqual(ordered)
  })

  it('an overlapping booking does not open a phantom gap after the shorter one', () => {
    // THE BUG THIS FUNCTION EXISTS TO FIX. Ordered by check-IN, the last row is
    // the short inner booking, so pairing row[i].checkout with
    // row[i+1].checkin walked off the end at Sep 10 and called the property
    // free from then — while the outer booking still had it until Sep 20.
    expect(deriveVacancyGaps([b('2026-09-01', '2026-09-20'), b('2026-09-05', '2026-09-10')], 30))
      .toEqual([{ start: '2026-09-20', end: null, days: 30 }])
  })

  it('emits nothing for an empty list without a horizon — the cron\'s contract', () => {
    expect(deriveVacancyGaps([], 90)).toEqual([])
  })

  it('with a horizon, an unbooked property is one open gap from the horizon', () => {
    expect(deriveVacancyGaps([], 62, '2026-09-01'))
      .toEqual([{ start: '2026-09-01', end: null, days: 62 }])
  })

  it('with a horizon, the period BEFORE the first booking counts', () => {
    // The most vacant a property ever is, and the cron deliberately never sees
    // it: its gaps are windows that open when a guest LEAVES.
    const withHorizon = deriveVacancyGaps([b('2026-09-10', '2026-09-15')], 62, '2026-09-01')
    expect(withHorizon[0]).toEqual({ start: '2026-09-01', end: '2026-09-10', days: 9 })

    expect(deriveVacancyGaps([b('2026-09-10', '2026-09-15')], 62))
      .toEqual([{ start: '2026-09-15', end: null, days: 62 }])
  })

  it('a horizon inside the first booking adds no leading gap', () => {
    expect(deriveVacancyGaps([b('2026-08-28', '2026-09-06')], 62, '2026-09-01'))
      .toEqual([{ start: '2026-09-06', end: null, days: 62 }])
  })
})

describe('monthBounds', () => {
  it('handles month lengths and leap years', () => {
    expect(monthBounds('2026-09-15')).toEqual({ first: '2026-09-01', last: '2026-09-30' })
    expect(monthBounds('2026-02-10')).toEqual({ first: '2026-02-01', last: '2026-02-28' })
    expect(monthBounds('2028-02-10')).toEqual({ first: '2028-02-01', last: '2028-02-29' })
    expect(monthBounds('2026-12-31')).toEqual({ first: '2026-12-01', last: '2026-12-31' })
  })
})

describe('pickVacantDayInMonth', () => {
  const gapsFor = (bookings: { checkin_date: string; checkout_date: string }[], month = '2026-09-01') =>
    deriveVacancyGaps(bookings, 62, monthBounds(month).first)

  it('leaves a date that is already free exactly where it is', () => {
    const gaps = gapsFor([b('2026-09-01', '2026-09-05'), b('2026-09-20', '2026-09-25')])
    expect(pickVacantDayInMonth('2026-09-12', gaps)).toBe('2026-09-12')
  })

  it('moves a date inside a stay to the nearest free day', () => {
    // Booked 10th–20th. The 12th is closer to the 10th (the last free morning
    // being the 10th? no — checkin blocks the 10th) than to the 20th checkout.
    const gaps = gapsFor([b('2026-09-10', '2026-09-20')])
    expect(pickVacantDayInMonth('2026-09-12', gaps)).toBe('2026-09-09')
    expect(pickVacantDayInMonth('2026-09-18', gaps)).toBe('2026-09-20')
  })

  it('the checkout day is free and the checkin day is not', () => {
    // A gap is [checkout, next checkin): the property empties on checkout
    // morning and is taken again on arrival.
    const gaps = gapsFor([b('2026-09-01', '2026-09-10'), b('2026-09-15', '2026-09-30')])
    expect(pickVacantDayInMonth('2026-09-10', gaps)).toBe('2026-09-10')
    expect(pickVacantDayInMonth('2026-09-15', gaps)).toBe('2026-09-14')
  })

  it('NEVER leaves the month, even when the nearest free day is next door', () => {
    // Booked solid through September, free from October 1st. Moving there would
    // re-anchor a quarterly series from September to October, and the one after
    // to January. The date stays put and the PM reschedules if they want to.
    const gaps = gapsFor([b('2026-08-25', '2026-10-04')])
    expect(pickVacantDayInMonth('2026-09-15', gaps)).toBe('2026-09-15')
  })

  it('returns the target unchanged when the property has no bookings on file', () => {
    // A new property, or a channel not yet connected. Every day is free, so
    // the requested one already is.
    expect(pickVacantDayInMonth('2026-09-15', gapsFor([]))).toBe('2026-09-15')
  })

  it('a tie goes to the EARLIER day', () => {
    // Booked 11th–20th, so the free edges are the 10th and the 20th and the
    // 15th sits exactly five days from each. Sooner is worth more, and it
    // leaves room to reschedule inside the same month.
    const gaps = gapsFor([b('2026-09-11', '2026-09-20')])
    expect(pickVacantDayInMonth('2026-09-15', gaps)).toBe('2026-09-10')
  })

  it('picks the genuinely nearer edge when it is the LATER one', () => {
    // The tie-break must not become a preference. Booked 10th–20th puts the
    // 15th six days from the 9th and five from the 20th.
    const gaps = gapsFor([b('2026-09-10', '2026-09-20')])
    expect(pickVacantDayInMonth('2026-09-15', gaps)).toBe('2026-09-20')
  })

  it('clamps an open-ended gap to the end of the month', () => {
    // Last checkout September 28th, nothing after: the open gap runs 62 days,
    // but a September occurrence may only land on the 28th, 29th or 30th.
    const gaps = gapsFor([b('2026-09-01', '2026-09-28')])
    expect(pickVacantDayInMonth('2026-09-15', gaps)).toBe('2026-09-28')
  })

  it('a gap entirely in a different month is not a candidate', () => {
    const gaps = deriveVacancyGaps(
      [b('2026-09-01', '2026-09-30'), b('2026-10-10', '2026-10-20')],
      62, '2026-09-01',
    )
    // September is booked solid; the September 30th–October 10th gap starts on
    // the 30th, which IS in September and is the answer.
    expect(pickVacantDayInMonth('2026-09-15', gaps)).toBe('2026-09-30')
  })
})
