import { describe, it, expect } from 'vitest'
import {
  partOfDayFor, localHourIn, isPartOfDay, isUnavailableAt,
  AFTERNOON_STARTS_AT_HOUR, EVENING_STARTS_AT_HOUR,
} from '@/lib/scheduling/part-of-day'

// Central Time is UTC-5 in October (CDT), so 15:00Z is 10am local.
const at = (iso: string) => new Date(iso)

describe('partOfDayFor', () => {
  it('reads the hour in the operating timezone, not UTC', () => {
    // 15:00Z is 10am Central — morning. In UTC it would read as afternoon,
    // which is the bug this timezone handling exists to prevent.
    expect(partOfDayFor(at('2026-10-13T15:00:00Z'))).toBe('morning')
  })

  it('places each window', () => {
    expect(partOfDayFor(at('2026-10-13T13:00:00Z'))).toBe('morning')    // 8am CT
    expect(partOfDayFor(at('2026-10-13T18:00:00Z'))).toBe('afternoon')  // 1pm CT
    expect(partOfDayFor(at('2026-10-13T23:00:00Z'))).toBe('evening')    // 6pm CT
  })

  it('puts each boundary in the LATER window', () => {
    expect(partOfDayFor(at('2026-10-13T17:00:00Z'))).toBe('afternoon')  // exactly noon CT
    expect(partOfDayFor(at('2026-10-13T22:00:00Z'))).toBe('evening')    // exactly 5pm CT
  })

  it('handles the minute before each boundary', () => {
    expect(partOfDayFor(at('2026-10-13T16:59:00Z'))).toBe('morning')
    expect(partOfDayFor(at('2026-10-13T21:59:00Z'))).toBe('afternoon')
  })

  // Half the year the same UTC instant is a different local hour. A fixed
  // offset would move every boundary by an hour twice a year.
  it('tracks daylight saving', () => {
    expect(partOfDayFor(at('2026-10-13T17:30:00Z'))).toBe('afternoon')  // CDT: 12:30pm
    expect(partOfDayFor(at('2026-12-13T17:30:00Z'))).toBe('morning')    // CST: 11:30am
  })

  it('normalises midnight rather than letting it fall outside every window', () => {
    expect(localHourIn(at('2026-10-13T05:00:00Z'))).toBe(0)             // midnight CT
    expect(partOfDayFor(at('2026-10-13T05:00:00Z'))).toBe('morning')
  })

  it('agrees with the exported boundary constants', () => {
    expect(AFTERNOON_STARTS_AT_HOUR).toBe(12)
    expect(EVENING_STARTS_AT_HOUR).toBe(17)
  })
})

describe('isPartOfDay', () => {
  it('accepts exactly what the database CHECK accepts', () => {
    expect(isPartOfDay('morning')).toBe(true)
    expect(isPartOfDay('afternoon')).toBe(true)
    expect(isPartOfDay('evening')).toBe(true)
  })

  it('rejects anything else, including near misses and non-strings', () => {
    expect(isPartOfDay('all_day')).toBe(false)
    expect(isPartOfDay('Morning')).toBe(false)
    expect(isPartOfDay(null)).toBe(false)
    expect(isPartOfDay(undefined)).toBe(false)
    expect(isPartOfDay(3)).toBe(false)
  })
})

describe('isUnavailableAt', () => {
  const morning   = at('2026-10-13T14:00:00Z')   // 9am CT
  const afternoon = at('2026-10-13T19:00:00Z')   // 2pm CT

  it('treats a whole-day-off row as unavailable at any hour', () => {
    const row = { is_available: false, unavailable_parts: null }
    expect(isUnavailableAt(row, morning)).toBe(true)
    expect(isUnavailableAt(row, afternoon)).toBe(true)
  })

  it('treats a plain available row as available at any hour', () => {
    const row = { is_available: true, unavailable_parts: null }
    expect(isUnavailableAt(row, morning)).toBe(false)
    expect(isUnavailableAt(row, afternoon)).toBe(false)
  })

  it('excludes only the named window', () => {
    const row = { is_available: true, unavailable_parts: ['morning'] }
    expect(isUnavailableAt(row, morning)).toBe(true)
    expect(isUnavailableAt(row, afternoon)).toBe(false)
  })

  it('handles two windows at once', () => {
    const row = { is_available: true, unavailable_parts: ['morning', 'evening'] }
    expect(isUnavailableAt(row, morning)).toBe(true)
    expect(isUnavailableAt(row, afternoon)).toBe(false)
    expect(isUnavailableAt(row, at('2026-10-14T00:00:00Z'))).toBe(true)   // 7pm CT
  })

  // An empty array is rejected by the CHECK, but a defensive reader must not
  // treat "no windows" as "every window".
  it('treats an empty array as fully available', () => {
    expect(isUnavailableAt({ is_available: true, unavailable_parts: [] }, morning)).toBe(false)
  })

  // is_available false wins outright: the row says the day is off, and a
  // stray parts value must not narrow that back to one window.
  it('lets whole-day-off win over any windows on the same row', () => {
    const row = { is_available: false, unavailable_parts: ['morning'] }
    expect(isUnavailableAt(row, afternoon)).toBe(true)
  })
})
