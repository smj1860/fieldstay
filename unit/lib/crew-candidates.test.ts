import { describe, it, expect } from 'vitest'

import { scoreCrewCandidates, topCrewCandidate, crewSuggestionReasoning, type CrewCandidate } from '@/lib/scoring/crew-candidates'

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
      workloadMap:     {},
    })
    expect(scored.map((s) => s.crew_member_id)).toEqual(['b', 'a'])
  })

  it('weights familiarity highest on a standard turnover', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false,
      property:  { lat: null, lng: null },
      crew:      [crew({ id: 'familiar' }), crew({ id: 'stranger' })],
      familiarCrewIds: ['familiar'],
      workloadMap:     {},
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
      isSameDay: true, property, crew: [far, near], familiarCrewIds: ['far'], workloadMap: {},
    })
    expect(sameDay[0]!.crew_member_id).toBe('near')

    const standard = scoreCrewCandidates({
      isSameDay: false, property, crew: [far, near], familiarCrewIds: ['far'], workloadMap: {},
    })
    expect(standard[0]!.crew_member_id).toBe('far')
  })

  it('coerces PostgREST numeric strings rather than concatenating them', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: null, lng: null },
      crew: [crew({ id: 'a', reliability_score: '0.85', capacity_score: '0.9' })],
      familiarCrewIds: [], workloadMap: {},
    })
    expect(top!.breakdown.reliability).toBe(0.85)
    expect(top!.breakdown.capacity).toBe(0.9)
  })

  it('treats missing coordinates as neutral, not as a penalty', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: 32.5, lng: -85.9 },
      crew: [crew({ id: 'nohome' })], familiarCrewIds: [], workloadMap: {},
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
      familiarCrewIds: [], workloadMap: {},
    })
    expect(top!.breakdown.proximity).toBe(0.5)
  })

  it('treats a "0.000000" property coordinate as missing, not as a real location', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: '0.000000', lng: '0.000000' },
      crew: [crew({ id: 'a', home_lat: 32.5, home_lng: -85.9 })],
      familiarCrewIds: [], workloadMap: {},
    })
    expect(top!.breakdown.proximity).toBe(0.5)
  })

  it('treats the literal number 0 the same way as the string sentinel', () => {
    // Covers the other direction too: if a coordinate ever arrives as a raw
    // JS number 0 rather than a string, it must be caught the same way.
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: 32.5, lng: -85.9 },
      crew: [crew({ id: 'zeroed', home_lat: 0, home_lng: 0 })],
      familiarCrewIds: [], workloadMap: {},
    })
    expect(top!.breakdown.proximity).toBe(0.5)
  })

  it('still scores a genuine, non-zero coordinate normally', () => {
    // Guards against overcorrecting into treating every coordinate as absent.
    const property = { lat: 32.5, lng: -85.9 }
    const [top] = scoreCrewCandidates({
      isSameDay: false, property,
      crew: [crew({ id: 'here', home_lat: 32.5, home_lng: -85.9 })],
      familiarCrewIds: [], workloadMap: {},
    })
    expect(top!.breakdown.proximity).toBeGreaterThan(0.5)
  })

  it('penalises the busiest crew member on workload, relatively', () => {
    const scored = scoreCrewCandidates({
      isSameDay: false, property: { lat: null, lng: null },
      crew: [crew({ id: 'busy' }), crew({ id: 'free' })],
      familiarCrewIds: [], workloadMap: { busy: 4 },
    })
    expect(scored[0]!.crew_member_id).toBe('free')
    expect(scored.find((s) => s.crew_member_id === 'busy')!.breakdown.workload).toBe(0)
  })

  it('does not divide by zero when nobody has upcoming work', () => {
    const [top] = scoreCrewCandidates({
      isSameDay: false, property: { lat: null, lng: null },
      crew: [crew({ id: 'a' })], familiarCrewIds: [], workloadMap: {},
    })
    expect(Number.isNaN(top!.score)).toBe(false)
    expect(top!.breakdown.workload).toBe(1)
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
      crew: [], familiarCrewIds: [], workloadMap: {},
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
      isSameDay: true, property, crew: [far, near], familiarCrewIds: ['far'], workloadMap: {},
    })
    expect(top!.crew_member_id).toBe('near')
  })
})

describe('crewSuggestionReasoning', () => {
  const base = { crew_member_id: 'a', name: 'Dana', score: 0.9 }

  it('lists every reason that applies', () => {
    expect(crewSuggestionReasoning({
      ...base,
      breakdown: { familiarity: 1, proximity: 0.9, reliability: 0.95, capacity: 1, workload: 0.95 },
    })).toBe('Dana — knows this property, nearby, high reliability, light schedule')
  })

  it('falls back to the bare name when nothing stands out', () => {
    expect(crewSuggestionReasoning({
      ...base,
      breakdown: { familiarity: 0, proximity: 0.4, reliability: 0.5, capacity: 0.5, workload: 0.5 },
    })).toBe('Dana')
  })
})
