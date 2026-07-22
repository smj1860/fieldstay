import { describe, it, expect } from 'vitest'
import { parseLocalDate } from '@/lib/utils/date-validation'

describe('parseLocalDate', () => {
  it('parses a well-formed YYYY-MM-DD string to a UTC midnight Date', () => {
    const d = parseLocalDate('2026-07-06', 'checkout_date')
    expect(d.toISOString()).toBe('2026-07-06T00:00:00.000Z')
  })

  it('throws when the value is null', () => {
    expect(() => parseLocalDate(null, 'checkout_date'))
      .toThrow('checkout_date is missing or not a string: null')
  })

  it('throws when the value is undefined', () => {
    expect(() => parseLocalDate(undefined, 'checkout_date'))
      .toThrow('checkout_date is missing or not a string: undefined')
  })

  it('throws when the value is an empty string', () => {
    expect(() => parseLocalDate('', 'checkout_date')).toThrow('checkout_date is missing or not a string')
  })

  it('throws when the value is not in YYYY-MM-DD shape', () => {
    expect(() => parseLocalDate('07/06/2026', 'checkout_date'))
      .toThrow('checkout_date is not YYYY-MM-DD: "07/06/2026"')
  })

  it('throws when the value has a valid shape but a non-numeric month', () => {
    expect(() => parseLocalDate('2026-XX-06', 'checkout_date')).toThrow('is not YYYY-MM-DD')
  })

  it('throws when the value includes a time component', () => {
    expect(() => parseLocalDate('2026-07-06T00:00:00Z', 'checkout_date')).toThrow('is not YYYY-MM-DD')
  })

  it('accepts the last valid day of a 31-day month', () => {
    expect(() => parseLocalDate('2026-01-31', 'date')).not.toThrow()
  })

  it('accepts February 29 in a leap year', () => {
    const d = parseLocalDate('2024-02-29', 'date')
    expect(d.toISOString()).toBe('2024-02-29T00:00:00.000Z')
  })

  // ------------------------------------------------------------------
  // Regression tests for a real bug found and fixed in this pass:
  // JS's Date ISO parser silently rolls a non-existent calendar date
  // forward to the next valid date (e.g. "2026-02-30" -> March 2) instead
  // of rejecting it. That defeated the entire purpose of this function,
  // whose docstring explicitly promises "strict" parsing that never lets
  // an invalid value silently propagate through downstream date
  // arithmetic. Fixed in lib/utils/date-validation.ts by round-tripping
  // the parsed Date back to YYYY-MM-DD and comparing against the input.
  // ------------------------------------------------------------------
  it('BUGFIX: rejects February 29 in a non-leap year instead of silently rolling to March 1', () => {
    expect(() => parseLocalDate('2026-02-29', 'date'))
      .toThrow('date is not a valid calendar date: "2026-02-29"')
  })

  it('BUGFIX: rejects February 30 instead of silently rolling to March 2', () => {
    expect(() => parseLocalDate('2026-02-30', 'date'))
      .toThrow('date is not a valid calendar date: "2026-02-30"')
  })

  it('BUGFIX: rejects April 31 instead of silently rolling to May 1', () => {
    expect(() => parseLocalDate('2026-04-31', 'date'))
      .toThrow('date is not a valid calendar date: "2026-04-31"')
  })

  it('BUGFIX: rejects November 31 instead of silently rolling to December 1', () => {
    expect(() => parseLocalDate('2026-11-31', 'date'))
      .toThrow('date is not a valid calendar date: "2026-11-31"')
  })
})
