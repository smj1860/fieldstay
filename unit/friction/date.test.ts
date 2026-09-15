import { describe, it, expect } from 'vitest'
import { frictionDayUtcBounds } from '@/lib/friction/date'

// ============================================================================
// pre-flight-friction.ts used to query `checkout_datetime` with
// `${turnoverDate}T00:00:00Z` / `T23:59:59.999Z` — string-concatenating a
// literal `Z` onto a Chicago-formatted (frictionDateString()) date, which
// tells Postgres those digits are UTC midnight. Central Time is UTC-5 (CDT)
// or UTC-6 (CST), so the window was shifted 5-6 hours off the real Chicago
// day: a late-evening checkout fell OUTSIDE the window (silently unscored),
// and an early-evening checkout the day before fell INSIDE it (scored a day
// early). frictionDayUtcBounds() resolves the REAL UTC offset in effect on
// that specific calendar day (DST-aware) instead of assuming a fixed one.
// ============================================================================

describe('frictionDayUtcBounds', () => {
  it('resolves CDT (summer, UTC-5) correctly', () => {
    expect(frictionDayUtcBounds('2026-09-15')).toEqual({
      startUtc: '2026-09-15T05:00:00.000Z',
      endUtc:   '2026-09-16T05:00:00.000Z',
    })
  })

  it('resolves CST (winter, UTC-6) correctly', () => {
    expect(frictionDayUtcBounds('2026-01-15')).toEqual({
      startUtc: '2026-01-15T06:00:00.000Z',
      endUtc:   '2026-01-16T06:00:00.000Z',
    })
  })

  it('never uses a naive UTC-midnight guess — the bug this replaces', () => {
    // The old (buggy) behavior: `${ymd}T00:00:00Z`. A correct CDT bound must
    // NOT equal that literal string.
    const { startUtc } = frictionDayUtcBounds('2026-09-15')
    expect(startUtc).not.toBe('2026-09-15T00:00:00.000Z')
  })

  it('produces exactly a 24-hour window', () => {
    const { startUtc, endUtc } = frictionDayUtcBounds('2026-09-15')
    const diffMs = new Date(endUtc).getTime() - new Date(startUtc).getTime()
    expect(diffMs).toBe(24 * 60 * 60 * 1000)
  })

  it('a late-evening CDT checkout falls inside its own day\'s window, not the next', () => {
    // 8pm CT on the 15th = 2026-09-16T01:00:00Z in CDT (UTC-5) — the exact
    // case the old `${ymd}T00:00:00Z..T23:59:59.999Z` bound silently dropped.
    const lateCheckout = new Date('2026-09-16T01:00:00Z').getTime()
    const { startUtc, endUtc } = frictionDayUtcBounds('2026-09-15')
    expect(lateCheckout).toBeGreaterThanOrEqual(new Date(startUtc).getTime())
    expect(lateCheckout).toBeLessThan(new Date(endUtc).getTime())
  })

  it('an early-evening CDT checkout the PRIOR day does not leak into the next day\'s window', () => {
    // 7pm CT on the 14th = 2026-09-15T00:00:00Z in CDT — the case the old
    // bound scored a day early.
    const priorEveningCheckout = new Date('2026-09-15T00:00:00Z').getTime()
    const { startUtc } = frictionDayUtcBounds('2026-09-15')
    expect(priorEveningCheckout).toBeLessThan(new Date(startUtc).getTime())
  })

  it('handles the DST spring-forward transition day using the offset in effect at midnight', () => {
    // 2026-03-08 is the US spring-forward date; midnight Chicago time that
    // day is still CST (UTC-6), before the 2am transition.
    expect(frictionDayUtcBounds('2026-03-08').startUtc).toBe('2026-03-08T06:00:00.000Z')
  })

  it('handles the DST fall-back transition day using the offset in effect at midnight', () => {
    // 2026-11-01 is the US fall-back date; midnight Chicago time that day is
    // still CDT (UTC-5).
    expect(frictionDayUtcBounds('2026-11-01').startUtc).toBe('2026-11-01T05:00:00.000Z')
  })
})
