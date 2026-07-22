import { describe, it, expect } from 'vitest'
import { unwrapJoin, unwrapJoinArray } from '@/lib/utils/supabase-joins'

interface Row {
  id: string
}

describe('unwrapJoin', () => {
  it('returns the single item for a one-item array', () => {
    const row: Row = { id: 'a' }
    expect(unwrapJoin([row])).toEqual(row)
  })

  it('returns the first item for a multi-item array', () => {
    const rows: Row[] = [{ id: 'a' }, { id: 'b' }]
    expect(unwrapJoin(rows)).toEqual({ id: 'a' })
  })

  it('returns null for an empty array', () => {
    expect(unwrapJoin<Row>([])).toBeNull()
  })

  it('returns null for null', () => {
    expect(unwrapJoin<Row>(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(unwrapJoin<Row>(undefined)).toBeNull()
  })

  it('passes through a bare (non-array) object unchanged', () => {
    const row: Row = { id: 'solo' }
    expect(unwrapJoin(row)).toEqual(row)
  })

  it('preserves object identity for a bare object (no unnecessary copy)', () => {
    const row: Row = { id: 'solo' }
    expect(unwrapJoin(row)).toBe(row)
  })

  it('preserves object identity for the extracted array element', () => {
    const row: Row = { id: 'a' }
    expect(unwrapJoin([row])).toBe(row)
  })
})

describe('unwrapJoinArray', () => {
  it('returns the array unchanged for a multi-item array', () => {
    const rows: Row[] = [{ id: 'a' }, { id: 'b' }]
    expect(unwrapJoinArray(rows)).toEqual(rows)
  })

  it('returns a one-item array unchanged (still an array)', () => {
    const rows: Row[] = [{ id: 'a' }]
    expect(unwrapJoinArray(rows)).toEqual(rows)
  })

  it('returns an empty array for an empty array input', () => {
    expect(unwrapJoinArray<Row>([])).toEqual([])
  })

  it('returns an empty array for null', () => {
    expect(unwrapJoinArray<Row>(null)).toEqual([])
  })

  it('returns an empty array for undefined', () => {
    expect(unwrapJoinArray<Row>(undefined)).toEqual([])
  })

  it('wraps a bare (non-array) object into a single-item array', () => {
    const row: Row = { id: 'solo' }
    expect(unwrapJoinArray(row)).toEqual([row])
  })

  it('preserves object identity when wrapping a bare object', () => {
    const row: Row = { id: 'solo' }
    expect(unwrapJoinArray(row)[0]).toBe(row)
  })
})
