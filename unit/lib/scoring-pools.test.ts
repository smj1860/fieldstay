import { describe, it, expect } from 'vitest'
import { computeWorkloadMap, computeFamiliarIds, computeDayWorkloadMap, computePriorStopOrigins } from '@/lib/scoring/pools'

interface Row {
  entity_id: string | null | undefined
}

describe('computeWorkloadMap', () => {
  it('counts rows per entity id', () => {
    const rows: Row[] = [
      { entity_id: 'crew_1' },
      { entity_id: 'crew_1' },
      { entity_id: 'crew_2' },
    ]
    const map = computeWorkloadMap(rows, (r) => r.entity_id)
    expect(map).toEqual({ crew_1: 2, crew_2: 1 })
  })

  it('ignores rows with a null or undefined id', () => {
    const rows: Row[] = [
      { entity_id: 'crew_1' },
      { entity_id: null },
      { entity_id: undefined },
    ]
    const map = computeWorkloadMap(rows, (r) => r.entity_id)
    expect(map).toEqual({ crew_1: 1 })
  })

  it('returns an empty object for an empty input array', () => {
    expect(computeWorkloadMap([] as Row[], (r) => r.entity_id)).toEqual({})
  })

  it('returns an empty object when every row has a missing id', () => {
    const rows: Row[] = [{ entity_id: null }, { entity_id: undefined }]
    expect(computeWorkloadMap(rows, (r) => r.entity_id)).toEqual({})
  })
})

describe('computeFamiliarIds', () => {
  it('dedups repeated ids into a single entry', () => {
    const rows: Row[] = [
      { entity_id: 'crew_1' },
      { entity_id: 'crew_1' },
      { entity_id: 'crew_2' },
    ]
    const ids = computeFamiliarIds(rows, (r) => r.entity_id)
    expect(ids.sort()).toEqual(['crew_1', 'crew_2'])
  })

  it('ignores rows with a null or undefined id', () => {
    const rows: Row[] = [
      { entity_id: 'crew_1' },
      { entity_id: null },
      { entity_id: undefined },
    ]
    expect(computeFamiliarIds(rows, (r) => r.entity_id)).toEqual(['crew_1'])
  })

  it('returns an empty array for an empty input array', () => {
    expect(computeFamiliarIds([] as Row[], (r) => r.entity_id)).toEqual([])
  })

  it('preserves first-seen order (Set insertion order)', () => {
    const rows: Row[] = [
      { entity_id: 'crew_3' },
      { entity_id: 'crew_1' },
      { entity_id: 'crew_3' },
      { entity_id: 'crew_2' },
    ]
    expect(computeFamiliarIds(rows, (r) => r.entity_id)).toEqual(['crew_3', 'crew_1', 'crew_2'])
  })
})

// ── Phase D: per-day workload ──────────────────────────────────────────────

type DayRow = { crew: string | null; when: string | null }
const build = (rows: DayRow[]) =>
  computeDayWorkloadMap(rows, (r) => r.crew, (r) => r.when)

describe('computeDayWorkloadMap', () => {
  it('buckets by calendar day, per crew member', () => {
    expect(build([
      { crew: 'a', when: '2026-10-13T11:00:00Z' },
      { crew: 'a', when: '2026-10-13T15:00:00Z' },
      { crew: 'b', when: '2026-10-13T09:00:00Z' },
      { crew: 'a', when: '2026-10-14T09:00:00Z' },
    ])).toEqual({
      '2026-10-13': { a: 2, b: 1 },
      '2026-10-14': { a: 1 },
    })
  })

  /**
   * The reason the date comes from the string rather than from `new Date()`.
   * A 23:30 UTC checkout parsed into a Date and read with local getters lands
   * on the next day for a server east of UTC and the previous one for a
   * server west of it, so the same turnover would bucket differently
   * depending on where the function ran. Slicing is also what keeps this
   * agreeing with the `.split('T')[0]` that the crew_availability lookup
   * uses, which is the comparison the capacity check has to line up with.
   */
  it('takes the date from the ISO string, not the runtime timezone', () => {
    const original = process.env.TZ
    try {
      process.env.TZ = 'Pacific/Kiritimati' // UTC+14
      const east = build([{ crew: 'a', when: '2026-10-13T23:30:00Z' }])
      process.env.TZ = 'Pacific/Midway'     // UTC-11
      const west = build([{ crew: 'a', when: '2026-10-13T23:30:00Z' }])
      expect(east).toEqual(west)
      expect(east).toEqual({ '2026-10-13': { a: 1 } })
    } finally {
      process.env.TZ = original
    }
  })

  it('skips rows with no crew member or no timestamp', () => {
    expect(build([
      { crew: null,  when: '2026-10-13T11:00:00Z' },
      { crew: 'a',   when: null },
      { crew: 'a',   when: '2026-10-13T11:00:00Z' },
    ])).toEqual({ '2026-10-13': { a: 1 } })
  })

  it('is empty for no rows, so a caller gets {} rather than undefined', () => {
    expect(build([])).toEqual({})
  })

  // The two maps are built from the SAME row set and must agree on totals,
  // or the scorer's two workload terms are measuring different populations.
  it('totals to the same counts as computeWorkloadMap over the same rows', () => {
    const rows: DayRow[] = [
      { crew: 'a', when: '2026-10-13T11:00:00Z' },
      { crew: 'a', when: '2026-10-14T11:00:00Z' },
      { crew: 'b', when: '2026-10-13T11:00:00Z' },
    ]
    const flat = computeWorkloadMap(rows, (r) => r.crew)
    const byDay = build(rows)

    const summed: Record<string, number> = {}
    for (const day of Object.values(byDay)) {
      for (const [id, n] of Object.entries(day)) summed[id] = (summed[id] ?? 0) + n
    }
    expect(summed).toEqual(flat)
  })
})

describe('computePriorStopOrigins', () => {
  // The scorer's proximity term measures from here. Measuring from home is
  // right for a crew member's first job of the day and wrong for every job
  // after it, with 15% of the standard weight riding on the difference.
  const stop = (crew: string, when: string, lat: number, lng: number) =>
    ({ crewMemberId: crew, when, lat, lng })

  it('returns the LAST stop before the target, not the first', () => {
    const origins = computePriorStopOrigins([
      stop('dana', '2026-10-13T13:00:00Z', 32.1, -85.1),
      stop('dana', '2026-10-13T15:00:00Z', 32.2, -85.2),
    ], '2026-10-13T18:00:00Z')

    expect(origins.dana).toEqual({ lat: 32.2, lng: -85.2 })
  })

  it('ignores stops on other days', () => {
    const origins = computePriorStopOrigins([
      stop('dana', '2026-10-12T23:00:00Z', 32.1, -85.1),
      stop('dana', '2026-10-14T01:00:00Z', 32.3, -85.3),
    ], '2026-10-13T18:00:00Z')

    expect(origins.dana).toBeUndefined()
  })

  it('ignores stops at or after the target', () => {
    const origins = computePriorStopOrigins([
      stop('dana', '2026-10-13T18:00:00Z', 32.1, -85.1),   // the target itself
      stop('dana', '2026-10-13T20:00:00Z', 32.2, -85.2),
    ], '2026-10-13T18:00:00Z')

    expect(origins.dana).toBeUndefined()
  })

  // Absent, not present-with-null: the scorer's fall back to home is then the
  // ordinary missing-key path rather than a second special case.
  it('omits a crew member with no earlier stop that day', () => {
    const origins = computePriorStopOrigins([
      stop('dana', '2026-10-13T13:00:00Z', 32.1, -85.1),
    ], '2026-10-13T18:00:00Z')

    expect('sam' in origins).toBe(false)
  })

  it('keeps each crew member on their own day', () => {
    const origins = computePriorStopOrigins([
      stop('dana', '2026-10-13T13:00:00Z', 32.1, -85.1),
      stop('sam',  '2026-10-13T14:00:00Z', 33.1, -86.1),
    ], '2026-10-13T18:00:00Z')

    expect(origins).toEqual({
      dana: { lat: 32.1, lng: -85.1 },
      sam:  { lat: 33.1, lng: -86.1 },
    })
  })

  it('tolerates a row with no timestamp', () => {
    const origins = computePriorStopOrigins(
      [{ crewMemberId: 'dana', when: null, lat: 32.1, lng: -85.1 }],
      '2026-10-13T18:00:00Z',
    )
    expect(origins.dana).toBeUndefined()
  })

  // A property with no coordinates is still the prior STOP; the scorer is
  // what decides an unusable origin means falling back to home. Collapsing
  // the two here would hide "they are out working, we just cannot say where".
  it('reports a prior stop whose property has no coordinates', () => {
    const origins = computePriorStopOrigins(
      [{ crewMemberId: 'dana', when: '2026-10-13T13:00:00Z', lat: null, lng: null }],
      '2026-10-13T18:00:00Z',
    )
    expect(origins.dana).toEqual({ lat: null, lng: null })
  })
})
