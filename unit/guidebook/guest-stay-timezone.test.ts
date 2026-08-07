import { describe, it, expect, vi, afterEach } from 'vitest'
import { computeStay } from '@/app/g/b/[token]/page'

// ============================================================================
// The guest guidebook computed "what day is it for this guest" — and, next to
// it, "what hour is it" — in America/New_York for EVERY property, ignoring
// properties.timezone entirely (the column was not even selected).
//
// Two guest-visible consequences, both worst in the evening:
//
//   • computeStay: once Eastern rolls past midnight, `today >= checkoutDate`
//     fires, so a guest still mid-stay is shown CHECKOUT instructions. One
//     hour early in Central, two in Mountain, three in Pacific, five in Hawaii.
//   • hourOfDay: feeds getActiveSlotTypes(), which decides WHICH SPONSOR SLOTS
//     render. Sponsors pay for that placement, so the wrong hour shows the
//     wrong paying businesses — and the whole 5pm–8pm evening dining window on
//     the west coast reads as 8pm–11pm.
//
// Production already has 4 of 27 properties in America/Chicago, so this is
// live, not theoretical — and the error only grows as the product moves west.
// ============================================================================

afterEach(() => vi.useRealTimers())

/** Freezes wall-clock at a real instant so timezone maths is deterministic. */
function at(iso: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

describe('computeStay uses the property timezone, not Eastern', () => {
  // 2026-08-11T04:30:00Z is 11:30pm Aug 10 in Chicago and 12:30am Aug 11 in
  // New York. A guest checking out on Aug 11 is still mid-stay in Chicago.
  it('does not flip a Central guest to checkout while it is still checkout eve', () => {
    at('2026-08-11T04:30:00Z')

    const central = computeStay('2026-08-08', '2026-08-11', 'America/Chicago')
    expect(central.phase, 'still the last night of the stay in Chicago').toBe('mid')
  })

  // The same instant in the timezone the code used to hardcode. Keeping this
  // alongside proves the fixture actually straddles a date boundary rather
  // than passing for some unrelated reason.
  it('would have flipped under the old hardcoded Eastern behaviour', () => {
    at('2026-08-11T04:30:00Z')

    const eastern = computeStay('2026-08-08', '2026-08-11', 'America/New_York')
    expect(eastern.phase, 'Eastern has already rolled to checkout day').toBe('checkout')
  })

  it('reaches checkout once the guest\'s own day arrives', () => {
    at('2026-08-11T14:00:00Z') // 9am Chicago on checkout day

    expect(computeStay('2026-08-08', '2026-08-11', 'America/Chicago').phase).toBe('checkout')
  })

  it('reports arrival before check-in day in the property timezone', () => {
    at('2026-08-08T02:00:00Z') // 9pm Aug 7 in Chicago

    const stay = computeStay('2026-08-08', '2026-08-11', 'America/Chicago')
    expect(stay.phase).toBe('arrival')
    expect(stay.nightIndex).toBe(0)
    expect(stay.totalNights).toBe(3)
  })

  // Hawaii is the widest US offset and the case that shows the bug is not a
  // one-hour rounding curiosity.
  it('is five hours out from Eastern at the extreme', () => {
    at('2026-08-11T06:00:00Z') // 8pm Aug 10 in Honolulu, 2am Aug 11 in New York

    expect(computeStay('2026-08-08', '2026-08-11', 'Pacific/Honolulu').phase).toBe('mid')
    expect(computeStay('2026-08-08', '2026-08-11', 'America/New_York').phase).toBe('checkout')
  })

  it('counts nights from the dates, independent of timezone', () => {
    at('2026-08-09T18:00:00Z')

    for (const tz of ['America/New_York', 'America/Chicago', 'Pacific/Honolulu']) {
      expect(computeStay('2026-08-08', '2026-08-11', tz).totalNights, tz).toBe(3)
    }
  })
})
