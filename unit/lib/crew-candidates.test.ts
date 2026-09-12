import { describe, it, expect } from 'vitest'

import { scoreCrewCandidates, crewSuggestionReasoning, type CrewCandidate } from '@/lib/scoring/crew-candidates'

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
