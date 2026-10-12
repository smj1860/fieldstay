import { describe, it, expect } from 'vitest'

import { scoreCrewCandidates, topCrewCandidate, crewSuggestionReasoning, atDayCapacity, type CrewCandidate } from '@/lib/scoring/crew-candidates'

// Extracted out of auto-assign-turnover.ts so the friction forecaster's Smart
// Fix ranks candidates the same way the turnover board's suggestion does. The
// weights are asserted here rather than only exercised, because a silent
// change to them makes the two surfaces disagree about the same turnover
// without either looking wrong on its own.

const crew = (over: Partial<CrewCandidate> & { id: string }): CrewCandidate => ({
  name: over.id, home_lat: null, home_lng: null,
  reliability_score: 1, capacity_score: 1, ...over,
})

describe('scoreCrewCandidates', () => {
  it('returns candidates sorted best-first', () => {
    const scored = scoreCrewCandidates({
      isSameDay: false,
      property:  { lat: null, lng: null },
      crew:      [crew({ id: 'a', reliability_score: 0.5 }), crew({ id: 'b', reliability_score: 1 })],
      familiarCrewIds: [],
      workloadMap:     {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(scored.map((s) => s.crew_member_id)).toEqual(['b', 'a'])
  })

  it('weights familiarity highest on a standard turnover', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false,
      property:  { lat: null, lng: null },
      crew:      [crew({ id: 'familiar' }), crew({ id: 'stranger' })],
      familiarCrewIds: ['familiar'],
      workloadMap:     {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(top!.crew_member_id).toBe('familiar')
    expect(top!.breakdown.familiarity).toBe(1)
  })

  it('re-weights toward proximity on a same-day turnover', () => {
    // No slack in the window, so who can physically get there outranks who
    // knows the property.
    const property = { lat: 32.5, lng: -85.9 }
    const near = crew({ id: 'near', home_lat: 32.5,  home_lng: -85.9 })
    const far  = crew({ id: 'far',  home_lat: 40.7,  home_lng: -74.0 })

    const sameDay = scoreCrewCandidates({
      isSameDay: true, property, crew: [far, near], familiarCrewIds: ['far'], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(sameDay[0]!.crew_member_id).toBe('near')

    const standard = scoreCrewCandidates({
      isSameDay: false, property, crew: [far, near], familiarCrewIds: ['far'], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(standard[0]!.crew_member_id).toBe('far')
  })

  it('coerces PostgREST numeric strings rather than concatenating them', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: null, lng: null },
      crew: [crew({ id: 'a', reliability_score: '0.85', capacity_score: '0.9' })],
      familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(top!.breakdown.reliability).toBe(0.85)
    expect(top!.breakdown.capacity).toBe(0.9)
  })

  it('treats missing coordinates as neutral, not as a penalty', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: 32.5, lng: -85.9 },
      crew: [crew({ id: 'nohome' })], familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(top!.breakdown.proximity).toBe(0.5)
  })

  // ── Regression: the "0.000000" null-island sentinel ────────────────────
  // home_lat/home_lng/lat/lng are PostgrestNumeric — PostgREST serialises a
  // real numeric column value as a STRING, so a coordinate of exactly 0
  // arrives as the non-empty string "0.000000". A bare `!value` falsy check
  // is truthy for that string and lets it through as though it were a real
  // coordinate, computing a proximity score against (0°, 0°) — off the coast
  // of West Africa, nowhere near a US-based STR portfolio — instead of
  // falling back to the neutral UNKNOWN_PROXIMITY the check exists to give.

  it('treats a "0.000000" crew home coordinate as missing, not as a real location', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: 32.5, lng: -85.9 },
      crew: [crew({ id: 'zeroed', home_lat: '0.000000', home_lng: '0.000000' })],
      familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(top!.breakdown.proximity).toBe(0.5)
  })

  it('treats a "0.000000" property coordinate as missing, not as a real location', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: '0.000000', lng: '0.000000' },
      crew: [crew({ id: 'a', home_lat: 32.5, home_lng: -85.9 })],
      familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(top!.breakdown.proximity).toBe(0.5)
  })

  it('treats the literal number 0 the same way as the string sentinel', () => {
    // Covers the other direction too: if a coordinate ever arrives as a raw
    // JS number 0 rather than a string, it must be caught the same way.
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: 32.5, lng: -85.9 },
      crew: [crew({ id: 'zeroed', home_lat: 0, home_lng: 0 })],
      familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(top!.breakdown.proximity).toBe(0.5)
  })

  it('still scores a genuine, non-zero coordinate normally', () => {
    // Guards against overcorrecting into treating every coordinate as absent.
    const property = { lat: 32.5, lng: -85.9 }
    const [top] = scoreCrewCandidates({
      isSameDay: false, property,
      crew: [crew({ id: 'here', home_lat: 32.5, home_lng: -85.9 })],
      familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(top!.breakdown.proximity).toBeGreaterThan(0.5)
  })

  it('penalises the busiest crew member on workload, relatively', () => {
    const scored = scoreCrewCandidates({
      isSameDay: false, property: { lat: null, lng: null },
      crew: [crew({ id: 'busy' }), crew({ id: 'free' })],
      familiarCrewIds: [], workloadMap: { busy: 4 }, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(scored[0]!.crew_member_id).toBe('free')
    expect(scored.find((s) => s.crew_member_id === 'busy')!.breakdown.workload).toBe(0)
  })

  it('does not divide by zero when nobody has upcoming work', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: null, lng: null },
      crew: [crew({ id: 'a' })], familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(Number.isNaN(top!.score)).toBe(false)
    expect(top!.breakdown.workload).toBe(1)
  })
})

describe('proximity origin', () => {
  // The defect: proximity measured from HOME for a crew member who is
  // already out working. Someone whose morning job is next door to the
  // turnover being scored was treated as driving from their kitchen, and
  // proximity carries 15% of the standard weight.
  const property = { lat: 32.50, lng: -85.90 }
  const nextDoor = { lat: 32.50, lng: -85.90 }
  const farAway  = { lat: 35.00, lng: -90.00 }

  const score = (
    originByCrew: Record<string, { lat: number | null; lng: number | null } | null>,
    home: { home_lat: number | null; home_lng: number | null },
  ) => topCrewCandidate({
    isSameDay: true,
    property,
    crew: [crew({ id: 'dana', ...home })],
    familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {},
    originByCrew,
  })!.breakdown.proximity

  it('measures from the previous stop when there is one', () => {
    const fromNextDoor = score({ dana: nextDoor }, { home_lat: 35.0, home_lng: -90.0 })
    const fromHome     = score({}, { home_lat: 35.0, home_lng: -90.0 })

    expect(fromNextDoor).toBe(1.0)
    expect(fromHome).toBeLessThan(fromNextDoor)
  })

  it('measures from home for a crew member with no prior stop that day', () => {
    expect(score({}, { home_lat: 32.50, home_lng: -85.90 })).toBe(1.0)
  })

  it('falls back to home when the prior stop has no coordinates', () => {
    expect(score({ dana: { lat: null, lng: null } }, { home_lat: 32.50, home_lng: -85.90 })).toBe(1.0)
  })

  // (0, 0) is null island, which is what a failed geocode looks like once
  // coerced to a number, not a place anybody is working from.
  it('treats a null-island prior stop as no origin at all', () => {
    expect(score({ dana: { lat: 0, lng: 0 } }, { home_lat: 32.50, home_lng: -85.90 })).toBe(1.0)
  })

  it('is neutral, not penalised, with neither a prior stop nor a home', () => {
    expect(score({}, { home_lat: null, home_lng: null })).toBe(0.5)
  })

  it('is neutral when the PROPERTY has no coordinates, whatever the origin', () => {
    const proximity = topCrewCandidate({
      isSameDay: true,
      property: { lat: null, lng: null },
      crew: [crew({ id: 'dana', home_lat: 32.5, home_lng: -85.9 })],
      familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {},
      originByCrew: { dana: nextDoor },
    })!.breakdown.proximity

    expect(proximity).toBe(0.5)
  })

  it('scores a candidate out at a far stop below one starting from home nearby', () => {
    const fromFarStop = score({ dana: farAway }, { home_lat: 32.50, home_lng: -85.90 })
    expect(fromFarStop).toBeLessThan(1.0)
  })
})

describe('topCrewCandidate', () => {
  // A single O(n) pass over the same scoring as scoreCrewCandidates(), used
  // by every real caller that only ever reads index 0 of the sorted list.
  // These assert it agrees with scoreCrewCandidates()[0] rather than
  // re-deriving the scoring rules a second time.

  it('returns null for an empty candidate pool', () => {
    expect(topCrewCandidate({
      isSameDay: false, property: { lat: null, lng: null },
      crew: [], familiarCrewIds: [], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })).toBeNull()
  })

  it('agrees with scoreCrewCandidates()[0] on the best candidate', () => {
    const input = {
      isSameDay: false,
      property:  { lat: 32.5, lng: -85.9 },
      crew: [
        crew({ id: 'a', reliability_score: 0.5 }),
        crew({ id: 'b', reliability_score: 1, home_lat: 32.5, home_lng: -85.9 }),
        crew({ id: 'c', reliability_score: 0.9 }),
      ],
      familiarCrewIds: ['c'],
      workloadMap:     { a: 2 },
      dayWorkloadMap:  { a: 1 }, originByCrew: {},
    }
    const [expected] = scoreCrewCandidates(input)
    const top = topCrewCandidate(input)

    expect(top).not.toBeNull()
    expect(top!.crew_member_id).toBe(expected!.crew_member_id)
    expect(top!.score).toBeCloseTo(expected!.score)
  })

  it('re-weights toward proximity on a same-day turnover, same as the sorted list', () => {
    const property = { lat: 32.5, lng: -85.9 }
    const near = crew({ id: 'near', home_lat: 32.5, home_lng: -85.9 })
    const far  = crew({ id: 'far',  home_lat: 40.7, home_lng: -74.0 })

    const top = topCrewCandidate({
      isSameDay: true, property, crew: [far, near], familiarCrewIds: ['far'], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    expect(top!.crew_member_id).toBe('near')
  })
})

describe('crewSuggestionReasoning', () => {
  const base = { crew_member_id: 'a', name: 'Dana', score: 0.9 }

  it('lists every reason that applies', () => {
    expect(crewSuggestionReasoning({
      ...base,
      breakdown: { familiarity: 1, proximity: 0.9, reliability: 0.95, capacity: 1, workload: 0.95, dayWorkload: 0.95 },
    })).toBe('Dana — knows this property, nearby, high reliability, light schedule')
  })

  it('falls back to the bare name when nothing stands out', () => {
    expect(crewSuggestionReasoning({
      ...base,
      breakdown: { familiarity: 0, proximity: 0.4, reliability: 0.5, capacity: 0.5, workload: 0.5, dayWorkload: 0.5 },
    })).toBe('Dana')
  })
})

// ── Phase D: per-crew daily capacity ────────────────────────────────────────

describe('dayWorkload', () => {
  const property = { lat: null, lng: null }

  // The defect the whole split exists for: a 14-day count cannot tell three
  // jobs stacked on one Tuesday from three spread across a fortnight.
  it('separates a crowded day from a busy fortnight', () => {
    const scored = scoreCrewCandidates({
      isSameDay: false, property,
      crew: [crew({ id: 'stacked' }), crew({ id: 'spread' })],
      familiarCrewIds: [],
      // Identical fortnights. Only the day differs.
      workloadMap:    { stacked: 3, spread: 3 },
      originByCrew: {}, dayWorkloadMap: { stacked: 3, spread: 0 },
    })

    expect(scored[0]!.crew_member_id).toBe('spread')
    expect(scored.find((s) => s.crew_member_id === 'stacked')!.breakdown.workload)
      .toBe(scored.find((s) => s.crew_member_id === 'spread')!.breakdown.workload)
  })

  it('is relative to the busiest day, like workload is', () => {
    const scored = scoreCrewCandidates({
      isSameDay: false, property,
      crew: [crew({ id: 'busy' }), crew({ id: 'free' })],
      familiarCrewIds: [], workloadMap: {},
      dayWorkloadMap: { busy: 4 }, originByCrew: {},
    })
    expect(scored.find((s) => s.crew_member_id === 'busy')!.breakdown.dayWorkload).toBe(0)
    expect(scored.find((s) => s.crew_member_id === 'free')!.breakdown.dayWorkload).toBe(1)
  })

  // Both weight sets must still total 1.00, or every score silently shifts
  // scale and stored history stops comparing against new rows.
  it.each([true, false])('keeps the weights summing to 1 (isSameDay=%s)', (isSameDay) => {
    const [only] = scoreCrewCandidates({
      isSameDay, property,
      crew: [crew({ id: 'perfect', reliability_score: 1, capacity_score: 1 })],
      familiarCrewIds: ['perfect'], workloadMap: {}, dayWorkloadMap: {}, originByCrew: {},
    })
    // Every component is 1 except proximity, which is UNKNOWN_PROXIMITY (0.5)
    // with no coordinates — so a perfect score is 1 minus half that weight.
    const proximityWeight = isSameDay ? 0.40 : 0.15
    expect(only!.score).toBeCloseTo(1 - proximityWeight / 2, 10)
  })

  // The 14-day term is kept, not replaced: a day count alone would happily
  // stack someone's whole week onto consecutive days.
  it('still separates crew whose days are equally free', () => {
    const scored = scoreCrewCandidates({
      isSameDay: false, property,
      crew: [crew({ id: 'swamped' }), crew({ id: 'quiet' })],
      familiarCrewIds: [],
      workloadMap:    { swamped: 10 },
      dayWorkloadMap: {}, originByCrew: {},
    })
    expect(scored[0]!.crew_member_id).toBe('quiet')
  })
})

describe('atDayCapacity', () => {
  it('never excludes when no limit is set', () => {
    expect(atDayCapacity({ max_turnovers_per_day: null }, 99)).toBe(false)
    expect(atDayCapacity({}, 99)).toBe(false)
  })

  // `>=`: the count is assignments ALREADY held, and the turnover being
  // scored is not among them, so someone at exactly their cap is full.
  it('excludes at the limit, not one past it', () => {
    expect(atDayCapacity({ max_turnovers_per_day: 3 }, 2)).toBe(false)
    expect(atDayCapacity({ max_turnovers_per_day: 3 }, 3)).toBe(true)
    expect(atDayCapacity({ max_turnovers_per_day: 3 }, 4)).toBe(true)
  })

  it('treats a crew member with no assignments that day as free', () => {
    expect(atDayCapacity({ max_turnovers_per_day: 1 }, 0)).toBe(false)
  })
})

describe('crewSuggestionReasoning — light schedule', () => {
  const base = { crew_member_id: 'a', name: 'Dana', score: 0.9 }
  const bd = (over: Partial<import('@/lib/scoring/crew-candidates').CrewScoreBreakdown>) => ({
    familiarity: 0, proximity: 0.4, reliability: 0.5, capacity: 0.5,
    workload: 0.5, dayWorkload: 0.5, ...over,
  })

  // The PM is looking at a board showing that day. "Light schedule" next to
  // someone with three jobs that Tuesday reads as wrong, however quiet their
  // fortnight is.
  it('reads the day, not the fortnight', () => {
    expect(crewSuggestionReasoning({ ...base, breakdown: bd({ workload: 1, dayWorkload: 0.2 }) }))
      .toBe('Dana')
    expect(crewSuggestionReasoning({ ...base, breakdown: bd({ workload: 0.2, dayWorkload: 1 }) }))
      .toContain('light schedule')
  })
})
