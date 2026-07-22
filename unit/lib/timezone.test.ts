import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  propertyLocalToUtc,
  formatPropertyTime,
  propertyLocalNow,
  formatVendorWindow,
  formatPropertyDateTime,
} from '@/lib/utils/timezone'

describe('propertyLocalToUtc', () => {
  it('converts a Chicago summer (CDT, UTC-5) checkout time to UTC — matches the documented example', () => {
    const utc = propertyLocalToUtc('2026-07-06', '11:00', 'America/Chicago')
    expect(utc.toISOString()).toBe('2026-07-06T16:00:00.000Z')
  })

  it('converts a Chicago winter (CST, UTC-6) time to UTC using the correct standard-time offset', () => {
    const utc = propertyLocalToUtc('2026-01-15', '11:00', 'America/Chicago')
    expect(utc.toISOString()).toBe('2026-01-15T17:00:00.000Z')
  })

  it('uses the pre-transition offset the day before spring-forward (2026-03-08 in America/Chicago)', () => {
    const utc = propertyLocalToUtc('2026-03-07', '11:00', 'America/Chicago')
    expect(utc.toISOString()).toBe('2026-03-07T17:00:00.000Z') // CST, UTC-6
  })

  it('uses the post-transition offset on spring-forward day itself', () => {
    const utc = propertyLocalToUtc('2026-03-08', '11:00', 'America/Chicago')
    expect(utc.toISOString()).toBe('2026-03-08T16:00:00.000Z') // CDT, UTC-5 — clocks already sprang forward at 2am
  })

  it('uses the pre-transition offset the day before fall-back (2026-11-01 in America/Chicago)', () => {
    const utc = propertyLocalToUtc('2026-10-31', '11:00', 'America/Chicago')
    expect(utc.toISOString()).toBe('2026-10-31T16:00:00.000Z') // CDT, UTC-5
  })

  it('uses the post-transition offset on fall-back day itself', () => {
    const utc = propertyLocalToUtc('2026-11-01', '11:00', 'America/Chicago')
    expect(utc.toISOString()).toBe('2026-11-01T17:00:00.000Z') // CST, UTC-6 — clocks already fell back at 2am
  })

  it('handles a UTC-fixed timezone identically to a naive conversion', () => {
    const utc = propertyLocalToUtc('2026-07-06', '11:00', 'UTC')
    expect(utc.toISOString()).toBe('2026-07-06T11:00:00.000Z')
  })

  it('handles a year boundary correctly (Dec 31 23:00 local -> Jan 1 UTC)', () => {
    const utc = propertyLocalToUtc('2026-12-31', '23:00', 'UTC')
    expect(utc.toISOString()).toBe('2026-12-31T23:00:00.000Z')
    const utcChicago = propertyLocalToUtc('2026-12-31', '23:00', 'America/Chicago')
    expect(utcChicago.toISOString()).toBe('2027-01-01T05:00:00.000Z')
  })

  it('handles midnight correctly', () => {
    const utc = propertyLocalToUtc('2026-07-06', '00:00', 'America/Chicago')
    expect(utc.toISOString()).toBe('2026-07-06T05:00:00.000Z')
  })
})

describe('formatPropertyTime', () => {
  it('formats a short time without a timezone abbreviation', () => {
    expect(formatPropertyTime('15:00', '2026-07-06', 'America/Chicago', 'short')).toBe('3:00 PM')
  })

  it('formats a long time with the correct DST-aware timezone abbreviation (CDT in summer)', () => {
    expect(formatPropertyTime('15:00', '2026-07-06', 'America/Chicago', 'long')).toBe('3:00 PM CDT')
  })

  it('formats a long time with the correct DST-aware timezone abbreviation (CST in winter)', () => {
    expect(formatPropertyTime('11:00', '2026-01-15', 'America/Chicago', 'long')).toBe('11:00 AM CST')
  })

  it('defaults to short format when none is specified', () => {
    expect(formatPropertyTime('09:05', '2026-07-06', 'America/Chicago')).toBe('9:05 AM')
  })
})

describe('formatVendorWindow', () => {
  it('formats a checkout-to-checkin work window with a short start and long (tz-suffixed) end', () => {
    const window = formatVendorWindow('11:00', '15:00', '2026-07-06', 'America/Chicago')
    expect(window).toBe('11:00 AM – 3:00 PM CDT')
  })
})

describe('formatPropertyDateTime', () => {
  it('formats a stored UTC ISO timestamp in the property local timezone with date, time, and tz abbreviation', () => {
    expect(formatPropertyDateTime('2026-07-06T16:00:00.000Z', 'America/Chicago')).toBe('Jul 6, 2026, 11:00 AM CDT')
  })

  it('reflects a different local calendar day than the UTC date when near a day boundary', () => {
    // 2026-01-01T04:00:00Z is still Dec 31 evening in Chicago (CST, UTC-6).
    expect(formatPropertyDateTime('2026-01-01T04:00:00.000Z', 'America/Chicago')).toBe('Dec 31, 2025, 10:00 PM CST')
  })
})

describe('propertyLocalNow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a Date object whose UTC-getter fields reflect the property local wall-clock time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T18:30:00.000Z')) // 1:30 PM CDT in Chicago
    const local = propertyLocalNow('America/Chicago')
    expect(local.toISOString()).toBe('2026-07-22T13:30:00.000Z')
  })

  it('reflects the winter (CST) offset when the system time falls in standard time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T18:30:00.000Z')) // 12:30 PM CST in Chicago
    const local = propertyLocalNow('America/Chicago')
    expect(local.toISOString()).toBe('2026-01-15T12:30:00.000Z')
  })
})
