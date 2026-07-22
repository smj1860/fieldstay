import { describe, it, expect } from 'vitest'
import { computeWorkloadMap, computeFamiliarIds } from '@/lib/scoring/pools'

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
