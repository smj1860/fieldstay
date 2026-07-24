import { describe, it, expect } from 'vitest'
import { computeOccupancy } from '@/lib/owner-portal/occupancy'

describe('computeOccupancy', () => {
  it('returns zero rates and zero booked nights when there are no bookings', () => {
    const result = computeOccupancy([], '2026-07')

    expect(result.currentMonth.rate).toBe(0)
    expect(result.currentMonth.bookedNights).toBe(0)
    expect(result.currentMonth.totalNights).toBe(31) // July has 31 days
    expect(result.rolling12Month.rate).toBe(0)
    expect(result.sameMonthLastYear).toBeNull()
  })

  it('computes 100% occupancy for a single booking spanning the entire month', () => {
    const bookings = [{ checkin_date: '2026-07-01', checkout_date: '2026-08-01' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.currentMonth.bookedNights).toBe(31)
    expect(result.currentMonth.rate).toBe(100)
  })

  it('computes a partial-month occupancy rate correctly', () => {
    // 10 nights out of 31 in July 2026 ≈ 32%
    const bookings = [{ checkin_date: '2026-07-01', checkout_date: '2026-07-11' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.currentMonth.bookedNights).toBe(10)
    expect(result.currentMonth.rate).toBe(Math.round((10 / 31) * 100))
  })

  it('counts a booking that starts exactly at the period boundary in full', () => {
    const bookings = [{ checkin_date: '2026-07-01', checkout_date: '2026-07-04' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.currentMonth.bookedNights).toBe(3)
  })

  it('counts a booking that ends exactly at the period boundary (checkout day itself is not a booked night)', () => {
    const bookings = [{ checkin_date: '2026-07-29', checkout_date: '2026-08-01' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.currentMonth.bookedNights).toBe(3)
  })

  it('excludes a booking entirely outside the requested month', () => {
    const bookings = [{ checkin_date: '2026-06-01', checkout_date: '2026-06-10' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.currentMonth.bookedNights).toBe(0)
    expect(result.currentMonth.rate).toBe(0)
  })

  it('clips a booking that only partially overlaps the requested month at both ends', () => {
    // Booking spans June 25 – July 5; only June 25 - July 5 overlap within
    // July counts: July 1 through July 5 = 4 nights (checkout day excluded).
    const bookings = [{ checkin_date: '2026-06-25', checkout_date: '2026-07-05' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.currentMonth.bookedNights).toBe(4)
  })

  it('sums booked nights across multiple non-overlapping bookings in the same month', () => {
    const bookings = [
      { checkin_date: '2026-07-01', checkout_date: '2026-07-04' },
      { checkin_date: '2026-07-10', checkout_date: '2026-07-15' },
    ]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.currentMonth.bookedNights).toBe(3 + 5)
  })

  it('returns null sameMonthLastYear when no booking history reaches back that far', () => {
    // All booking history is entirely before July 2025 (the "last year"
    // window for a 2026-07 selection), so hasLastYearHistory is false.
    const bookings = [{ checkin_date: '2025-01-01', checkout_date: '2025-01-05' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.sameMonthLastYear).toBeNull()
  })

  it('computes sameMonthLastYear when a booking overlaps that period', () => {
    const bookings = [{ checkin_date: '2025-07-01', checkout_date: '2025-07-11' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.sameMonthLastYear).not.toBeNull()
    expect(result.sameMonthLastYear?.bookedNights).toBe(10)
    expect(result.sameMonthLastYear?.rate).toBe(Math.round((10 / 31) * 100))
  })

  it('scales totalNights by propertyCount for portfolio-level aggregates', () => {
    const bookings = [{ checkin_date: '2026-07-01', checkout_date: '2026-07-11' }]

    const result = computeOccupancy(bookings, '2026-07', 4)

    expect(result.currentMonth.totalNights).toBe(31 * 4)
    expect(result.currentMonth.bookedNights).toBe(10)
    expect(result.currentMonth.rate).toBe(Math.round((10 / (31 * 4)) * 100))
  })

  it('computes rolling 12-month totals spanning back 13 calendar months from the selected month', () => {
    const bookings = [{ checkin_date: '2025-08-01', checkout_date: '2026-08-01' }] // full 12 months booked

    const result = computeOccupancy(bookings, '2026-07')

    // rolling12Start = 2025-07-01, rolling12End = 2026-08-01 (13 months of days)
    expect(result.rolling12Month.bookedNights).toBe(365) // Aug 2025 - Jul 2026 = 365 nights
    expect(result.rolling12Month.rate).toBeGreaterThan(0)
    expect(result.rolling12Month.rate).toBeLessThanOrEqual(100)
  })

  it('never returns a negative booked-nights value for a booking entirely before the period', () => {
    const bookings = [{ checkin_date: '2020-01-01', checkout_date: '2020-01-05' }]

    const result = computeOccupancy(bookings, '2026-07')

    expect(result.currentMonth.bookedNights).toBe(0)
  })

  it('handles a February selection correctly (28-day month, non-leap year)', () => {
    const result = computeOccupancy([], '2026-02')

    expect(result.currentMonth.totalNights).toBe(28)
  })

  it('handles a leap-year February selection correctly (29 days)', () => {
    const result = computeOccupancy([], '2028-02')

    expect(result.currentMonth.totalNights).toBe(29)
  })
})
