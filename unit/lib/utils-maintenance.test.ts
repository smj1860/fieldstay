import { describe, it, expect, vi, afterEach } from 'vitest'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'

describe('isMaintenanceItemActiveThisMonth', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns true for an all-year item (both bounds null)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
    expect(isMaintenanceItemActiveThisMonth(null, null)).toBe(true)
  })

  it('returns true when either bound alone is null (not a valid seasonal window)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    expect(isMaintenanceItemActiveThisMonth(3, null)).toBe(true)
    expect(isMaintenanceItemActiveThisMonth(null, 9)).toBe(true)
  })

  it('returns true for the current month within a simple (non-wrapping) window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00Z')) // July = month 7
    expect(isMaintenanceItemActiveThisMonth(5, 9)).toBe(true) // May-Sep
  })

  it('returns false for the current month outside a simple window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z')) // December = month 12
    expect(isMaintenanceItemActiveThisMonth(5, 9)).toBe(false) // May-Sep
  })

  it('is inclusive at both boundary months of a simple window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z')) // start boundary, May
    expect(isMaintenanceItemActiveThisMonth(5, 9)).toBe(true)

    vi.setSystemTime(new Date('2026-09-30T23:59:59Z')) // end boundary, Sept
    expect(isMaintenanceItemActiveThisMonth(5, 9)).toBe(true)
  })

  it('handles a year-wrapping window (Nov-Mar) correctly for a month inside the wrap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z')) // January, inside Nov-Mar wrap
    expect(isMaintenanceItemActiveThisMonth(11, 3)).toBe(true)
  })

  it('handles a year-wrapping window correctly for a month outside the wrap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z')) // June, outside Nov-Mar wrap
    expect(isMaintenanceItemActiveThisMonth(11, 3)).toBe(false)
  })

  it('is inclusive at both boundary months of a year-wrapping window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z')) // start boundary, Nov
    expect(isMaintenanceItemActiveThisMonth(11, 3)).toBe(true)

    vi.setSystemTime(new Date('2026-03-31T23:59:59Z')) // end boundary, March
    expect(isMaintenanceItemActiveThisMonth(11, 3)).toBe(true)
  })

  it('treats an identical from/to month as active only in that single month', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
    expect(isMaintenanceItemActiveThisMonth(6, 6)).toBe(true)

    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    expect(isMaintenanceItemActiveThisMonth(6, 6)).toBe(false)
  })

  it('handles a December-to-January single-month-span wrap (active_from=12, active_to=1)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-25T12:00:00Z'))
    expect(isMaintenanceItemActiveThisMonth(12, 1)).toBe(true)

    vi.setSystemTime(new Date('2027-01-05T12:00:00Z'))
    expect(isMaintenanceItemActiveThisMonth(12, 1)).toBe(true)

    vi.setSystemTime(new Date('2026-02-01T12:00:00Z'))
    expect(isMaintenanceItemActiveThisMonth(12, 1)).toBe(false)
  })
})
