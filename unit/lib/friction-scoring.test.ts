import { describe, it, expect } from 'vitest'

import {
  computeFrictionScore, severityFromScore,
  crewDurationScore, weatherScore, weekendScore, holidayScore,
  seasonalScore, isSeasonalWindowActive, springBreakScore, interactionScore,
  normalizeStateCode, topFrictionReasons,
  type FrictionComponents,
} from '@/lib/scoring/friction'
import type { DayForecast } from '@/lib/weather/tomorrow'

// This logic governs a severity flag that reaches the PM dashboard with no
// human review in between — the same bar checklist-signals is held to.

const forecast = (temperatureMax: number, precipitationProbability: number): DayForecast => ({
  temperatureMax,
  precipitationProbability,
  weatherCode:  1000,
  weatherLabel: 'Clear',
  isClear:      precipitationProbability < 25,
  fetchedAt:    '2026-07-04T00:00:00.000Z',
})

/** Local midnight, so no UTC-parsing day shift. */
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d)

describe('computeFrictionScore', () => {
  const zero: FrictionComponents = {
    crewDurationVsBaseline: 0, weather: 0, weekend: 0, holiday: 0,
    seasonal: 0, springBreak: 0, interaction: 0, localEvents: 0,
  }

  it('sums components', () => {
    expect(computeFrictionScore({ ...zero, weekend: 0.1, holiday: 0.15 })).toBeCloseTo(0.25, 10)
  })

  it('clamps the worst possible day to exactly 1.0, not 1.35', () => {
    // Every component at its documented max simultaneously: severe crew
    // overrun, hot AND rainy, a holiday landing on a weekend inside an active
    // season, in a spring-break window. The clamp is load-bearing, not
    // decorative — without it this stores a failure PROBABILITY above 1.
    const worst: FrictionComponents = {
      crewDurationVsBaseline: 0.50,
      weather:                0.15,
      weekend:                0.10,
      holiday:                0.15,
      seasonal:               0.15,
      springBreak:            0.10,
      interaction:            0.20,
      localEvents:            0,
    }
    const raw = Object.values(worst).reduce((a, b) => a + b, 0)
    expect(raw).toBeCloseTo(1.35, 10)
    expect(computeFrictionScore(worst)).toBe(1)
  })
})

describe('severityFromScore', () => {
  it.each([
    [0.00, 'none'], [0.54, 'none'],
    [0.55, 'high'], [0.84, 'high'],
    [0.85, 'critical'], [1.00, 'critical'],
  ] as const)('%s -> %s', (score, expected) => {
    expect(severityFromScore(score)).toBe(expected)
  })
})

describe('crewDurationScore', () => {
  it('scores 0 when the baseline fits the window', () => {
    expect(crewDurationScore(120, 240)).toBe(0)
    expect(crewDurationScore(240, 240)).toBe(0) // exactly consumed is still not friction
  })

  it('scales linearly from a 0% to a 50% overrun', () => {
    expect(crewDurationScore(300, 240)).toBeCloseTo(0.25, 10) // 25% over -> half the budget
    expect(crewDurationScore(360, 240)).toBeCloseTo(0.50, 10) // 50% over -> full budget
  })

  it('caps at the component budget however extreme the overrun', () => {
    expect(crewDurationScore(10_000, 240)).toBeCloseTo(0.50, 10)
  })

  it('treats a zero-or-negative window as maximal, not a divide-by-zero', () => {
    // Same-day check-in at the same minute as checkout. A NaN here would
    // propagate through the sum and store as a broken probability.
    expect(crewDurationScore(120, 0)).toBeCloseTo(0.50, 10)
    expect(crewDurationScore(120, -30)).toBeCloseTo(0.50, 10)
    expect(Number.isNaN(crewDurationScore(120, 0))).toBe(false)
  })

  it('scores 0 when there is no duration estimate at all', () => {
    // A brand-new org with no baselines anywhere — every other component
    // still scores, this one contributes nothing rather than guessing.
    expect(crewDurationScore(0, 240)).toBe(0)
  })
})

describe('weatherScore', () => {
  it('is additive — hot and rainy can both apply', () => {
    expect(weatherScore(forecast(70, 10))).toBe(0)
    expect(weatherScore(forecast(95, 10))).toBeCloseTo(0.08, 10)
    expect(weatherScore(forecast(70, 80))).toBeCloseTo(0.07, 10)
    expect(weatherScore(forecast(95, 80))).toBeCloseTo(0.15, 10)
  })

  it('uses the codebase-wide rainy bar, so a day cannot read rainy here and dry elsewhere', () => {
    // RAINY_PRECIP_PROBABILITY is 40 in lib/weather/tomorrow.ts.
    expect(weatherScore(forecast(70, 39))).toBe(0)
    expect(weatherScore(forecast(70, 40))).toBeCloseTo(0.07, 10)
  })

  it('uses a labour-strain heat bar, hotter than the guest-comfort one', () => {
    // WeatherContext.isHot is 85F; this is 90F deliberately.
    expect(weatherScore(forecast(88, 0))).toBe(0)
    expect(weatherScore(forecast(90, 0))).toBeCloseTo(0.08, 10)
  })
})

describe('weekendScore', () => {
  it('covers Friday, Saturday and Sunday checkouts', () => {
    expect(weekendScore(day(2026, 7, 3))).toBeCloseTo(0.10, 10) // Friday
    expect(weekendScore(day(2026, 7, 4))).toBeCloseTo(0.10, 10) // Saturday
    expect(weekendScore(day(2026, 7, 5))).toBeCloseTo(0.10, 10) // Sunday
  })

  it('is zero midweek', () => {
    expect(weekendScore(day(2026, 7, 7))).toBe(0) // Tuesday
  })
})

describe('holidayScore — date math', () => {
  // Verified against real calendars. These stay pinned so a future edit to
  // nthWeekdayOfMonth/lastWeekdayOfMonth cannot silently move a holiday.
  it.each([
    ['Memorial Day 2026', 2026, 5, 25],
    ['Memorial Day 2027', 2027, 5, 31],
    ['Memorial Day 2028', 2028, 5, 29],
    ['Labor Day 2026',    2026, 9,  7],
    ['Labor Day 2027',    2027, 9,  6],
    ['Labor Day 2028',    2028, 9,  4],
    ['Thanksgiving 2026', 2026, 11, 26],
    ['Thanksgiving 2027', 2027, 11, 25],
    ['Thanksgiving 2028', 2028, 11, 23],
  ])('%s is inside a holiday window', (_label, y, m, d) => {
    expect(holidayScore(day(y, m, d))).toBeCloseTo(0.15, 10)
  })

  it('covers the Memorial Day weekend from its Saturday', () => {
    expect(holidayScore(day(2026, 5, 23))).toBeCloseTo(0.15, 10) // Saturday
    expect(holidayScore(day(2026, 5, 22))).toBe(0)               // Friday before
  })

  it('covers July 4th plus a day either side', () => {
    expect(holidayScore(day(2026, 7, 3))).toBeCloseTo(0.15, 10)
    expect(holidayScore(day(2026, 7, 5))).toBeCloseTo(0.15, 10)
    expect(holidayScore(day(2026, 7, 6))).toBe(0)
  })

  it('covers Thanksgiving week from the Wednesday through the Sunday', () => {
    expect(holidayScore(day(2026, 11, 25))).toBeCloseTo(0.15, 10) // Wednesday
    expect(holidayScore(day(2026, 11, 29))).toBeCloseTo(0.15, 10) // Sunday
    expect(holidayScore(day(2026, 11, 30))).toBe(0)
  })

  it('carries the Christmas window across the year boundary', () => {
    // Jan 1 belongs to the window opened the PREVIOUS December — a naive
    // same-year-only check misses New Year's Day entirely, which is one of
    // the highest-traffic checkout days of the year.
    expect(holidayScore(day(2026, 12, 24))).toBeCloseTo(0.15, 10)
    expect(holidayScore(day(2027, 1, 1))).toBeCloseTo(0.15, 10)
    expect(holidayScore(day(2027, 1, 2))).toBe(0)
  })

  it('is zero on an ordinary day', () => {
    expect(holidayScore(day(2026, 3, 17))).toBe(0)
  })
})

describe('seasonalScore', () => {
  it('scores inside a summer window and not outside it', () => {
    expect(seasonalScore('summer_lake', day(2026, 7, 1))).toBeCloseTo(0.15, 10)
    expect(seasonalScore('summer_lake', day(2026, 10, 1))).toBe(0)
  })

  it('handles a window that crosses Dec 31', () => {
    expect(seasonalScore('ski', day(2026, 12, 20))).toBeCloseTo(0.15, 10)
    expect(seasonalScore('ski', day(2026, 2, 10))).toBeCloseTo(0.15, 10)
    expect(seasonalScore('ski', day(2026, 6, 10))).toBe(0)
  })

  it('gives none and year_round_urban nothing, on any date', () => {
    for (const date of [day(2026, 1, 15), day(2026, 7, 15), day(2026, 10, 15)]) {
      expect(seasonalScore('none', date)).toBe(0)
      expect(seasonalScore('year_round_urban', date)).toBe(0)
    }
  })

  it('gives an unknown profile nothing rather than throwing', () => {
    expect(seasonalScore('not_a_profile', day(2026, 7, 1))).toBe(0)
    expect(isSeasonalWindowActive('not_a_profile', day(2026, 7, 1))).toBe(false)
  })
})

describe('normalizeStateCode', () => {
  it('accepts both spellings the live properties.state column actually holds', () => {
    // Free-text column: production holds 'AL' and 'Alabama' for the same
    // state, more of them spelled out. Without this the region lookup would
    // miss most of the real portfolio and score 0 with no symptom.
    expect(normalizeStateCode('AL')).toBe('AL')
    expect(normalizeStateCode('al')).toBe('AL')
    expect(normalizeStateCode('Alabama')).toBe('AL')
    expect(normalizeStateCode('  alabama ')).toBe('AL')
  })

  it('returns null for empty or unrecognised input', () => {
    expect(normalizeStateCode(null)).toBeNull()
    expect(normalizeStateCode('')).toBeNull()
    expect(normalizeStateCode('   ')).toBeNull()
    expect(normalizeStateCode('Atlantis')).toBeNull()
  })
})

describe('springBreakScore', () => {
  const eligible = 'summer_lake'

  it.each([
    ['south_gulf',     'AL', day(2026, 3, 10)],
    ['midwest_plains', 'MN', day(2026, 3, 15)],
    ['west_coast',     'CA', day(2026, 3, 25)],
    ['northeast',      'NY', day(2026, 4, 5)],
    ['southwest',      'AZ', day(2026, 3, 10)],
    ['upper_south',    'VA', day(2026, 3, 20)],
  ])('scores inside the %s window', (_region, state, date) => {
    expect(springBreakScore(state, eligible, date)).toBeCloseTo(0.10, 10)
  })

  it('scores 0 outside every window', () => {
    expect(springBreakScore('AL', eligible, day(2026, 6, 15))).toBe(0)
    expect(springBreakScore('NY', eligible, day(2026, 1, 15))).toBe(0)
  })

  it('scores AK and HI on the west_coast window, by both spellings', () => {
    // Both run mid-March to the first week of April, which is west_coast's
    // 03-18..04-10 band. Both spellings, because properties.state is free text.
    for (const state of ['AK', 'HI', 'Alaska', 'Hawaii']) {
      expect(springBreakScore(state, eligible, day(2026, 3, 20))).toBeCloseTo(0.10, 10)
      expect(springBreakScore(state, eligible, day(2026, 4, 10))).toBeCloseTo(0.10, 10)
      // Outside the band on both sides — they follow west_coast, not a wider
      // window of their own.
      expect(springBreakScore(state, eligible, day(2026, 3, 17))).toBe(0)
      expect(springBreakScore(state, eligible, day(2026, 4, 11))).toBe(0)
    }
  })

  it('returns 0 for a state value that is not a US state', () => {
    // Every state and DC is mapped now, so this is the only remaining
    // fall-through — and properties.state is free text, so it is reachable.
    expect(springBreakScore('Atlantis', eligible, day(2026, 3, 20))).toBe(0)
    expect(springBreakScore('', eligible, day(2026, 3, 20))).toBe(0)
    expect(springBreakScore(null, eligible, day(2026, 3, 20))).toBe(0)
  })

  it('still gates AK and HI on the destination profile', () => {
    expect(springBreakScore('HI', 'fall_foliage', day(2026, 3, 20))).toBe(0)
    expect(springBreakScore('AK', 'none',         day(2026, 3, 20))).toBe(0)
  })

  it('gates on the destination profile', () => {
    const date = day(2026, 3, 10)
    expect(springBreakScore('AL', 'summer_lake',      date)).toBeCloseTo(0.10, 10)
    expect(springBreakScore('AL', 'coastal_summer',   date)).toBeCloseTo(0.10, 10)
    // Same state, same date, ineligible profile.
    expect(springBreakScore('AL', 'fall_foliage',     date)).toBe(0)
    expect(springBreakScore('AL', 'year_round_urban', date)).toBe(0)
    expect(springBreakScore('AL', 'none',             date)).toBe(0)
    // ski is deliberately excluded — spring skiing overlaps its own window
    // and whether to count it twice is a product call, not a code default.
    expect(springBreakScore('AL', 'ski',              date)).toBe(0)
  })

  it('derives upper_south from south_gulf by a shift, not a second literal', () => {
    // south_gulf is 03-01..03-27, so upper_south must be 03-08..04-03. If
    // either window is ever hardcoded independently this fails the moment
    // south_gulf moves — which is exactly what happened to southwest once.
    expect(springBreakScore('VA', eligible, day(2026, 3, 8))).toBeCloseTo(0.10, 10)
    expect(springBreakScore('VA', eligible, day(2026, 4, 3))).toBeCloseTo(0.10, 10)
    expect(springBreakScore('VA', eligible, day(2026, 3, 7))).toBe(0)
    expect(springBreakScore('VA', eligible, day(2026, 4, 4))).toBe(0)
  })

  it('derives southwest as the UNION of south_gulf and west_coast', () => {
    // 03-01 (south_gulf's start) through 04-10 (west_coast's end) — a union,
    // not an averaged midpoint, because AZ/NV draw from both at their own
    // different times.
    expect(springBreakScore('AZ', eligible, day(2026, 3, 1))).toBeCloseTo(0.10, 10)
    expect(springBreakScore('AZ', eligible, day(2026, 4, 10))).toBeCloseTo(0.10, 10)
    expect(springBreakScore('AZ', eligible, day(2026, 2, 28))).toBe(0)
    expect(springBreakScore('AZ', eligible, day(2026, 4, 11))).toBe(0)
  })

  it('maps the Mountain West onto the west_coast window', () => {
    expect(springBreakScore('CO', eligible, day(2026, 3, 25))).toBeCloseTo(0.10, 10)
    expect(springBreakScore('CO', eligible, day(2026, 3, 5))).toBe(0)
  })
})

describe('interactionScore — tiered and mutually exclusive', () => {
  // July 4th 2026 is a Saturday; summer_lake's window is open in July.
  const holidayWeekendInSeason = day(2026, 7, 4)

  it('picks the triple tier, NOT a sum of the pairs', () => {
    expect(interactionScore('summer_lake', holidayWeekendInSeason)).toBeCloseTo(0.20, 10)
    // The pairwise weights sum to 0.34 — independent additive terms would
    // double-count the shared factors.
    expect(interactionScore('summer_lake', holidayWeekendInSeason)).toBeLessThan(0.34)
  })

  it('scores holiday x weekend with NO active season', () => {
    // Season is an input, not a requirement.
    expect(interactionScore('none', holidayWeekendInSeason)).toBeCloseTo(0.14, 10)
  })

  it('scores holiday x season on a weekday', () => {
    // Dec 25 2026 is a Friday, so pick a midweek holiday date: Dec 30 2026 is
    // a Wednesday, inside the Christmas window and inside the ski season.
    const midweekHoliday = day(2026, 12, 30)
    expect(weekendScore(midweekHoliday)).toBe(0)
    expect(interactionScore('ski', midweekHoliday)).toBeCloseTo(0.12, 10)
  })

  it('scores weekend x season with no holiday', () => {
    const plainSummerSaturday = day(2026, 7, 18)
    expect(holidayScore(plainSummerSaturday)).toBe(0)
    expect(interactionScore('summer_lake', plainSummerSaturday)).toBeCloseTo(0.08, 10)
  })

  it('scores 0 with no profile and no holiday/weekend overlap', () => {
    expect(interactionScore('none', day(2026, 7, 7))).toBe(0) // ordinary Tuesday
  })
})

describe('topFrictionReasons', () => {
  it('returns the highest-weighted non-zero components, worst first', () => {
    expect(topFrictionReasons({
      crewDurationVsBaseline: 0.4, weather: 0.07, holiday: 0.15, localEvents: 0,
    })).toEqual(['crew pace vs. the turnover window', 'holiday travel window'])
  })

  it('never names a zero component', () => {
    expect(topFrictionReasons({ weekend: 0.1, localEvents: 0 })).toEqual(['weekend checkout'])
    expect(topFrictionReasons({ localEvents: 0 })).toEqual([])
  })
})
