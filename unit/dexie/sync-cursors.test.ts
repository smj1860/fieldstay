import { describe, it, expect } from 'vitest'
import { computeAdvancedCursor, partitionByKnown, CURSOR_OVERLAP_MS } from '@/lib/dexie/sync/cursors'

describe('computeAdvancedCursor', () => {
  it('advances to max(updated_at) minus the overlap window', () => {
    const next = computeAdvancedCursor(null, [
      '2026-07-24T10:00:00.000Z',
      '2026-07-24T10:05:00.000Z',
      '2026-07-24T09:59:00.000Z',
    ])
    expect(next).toBe(new Date(Date.parse('2026-07-24T10:05:00.000Z') - CURSOR_OVERLAP_MS).toISOString())
  })

  it('never moves backward — an older batch keeps the existing cursor', () => {
    const current = '2026-07-24T12:00:00.000Z'
    const next = computeAdvancedCursor(current, ['2026-07-24T10:00:00.000Z'])
    expect(next).toBe(current)
  })

  it('is a no-op (returns current) when the pull saw no rows', () => {
    expect(computeAdvancedCursor('2026-07-24T12:00:00.000Z', [])).toBe('2026-07-24T12:00:00.000Z')
    expect(computeAdvancedCursor(null, [])).toBeNull()
  })

  it('ignores null/undefined/garbage timestamps instead of poisoning the cursor', () => {
    const next = computeAdvancedCursor(null, [null, undefined, 'not-a-date', '2026-07-24T10:00:00.000Z'])
    expect(next).toBe(new Date(Date.parse('2026-07-24T10:00:00.000Z') - CURSOR_OVERLAP_MS).toISOString())
    expect(computeAdvancedCursor(null, [null, 'garbage'])).toBeNull()
  })
})

describe('partitionByKnown', () => {
  it('splits scope ids into known (cached) vs fresh (new to device)', () => {
    const { known, fresh } = partitionByKnown(['a', 'b', 'c'], new Set(['a', 'c']))
    expect(known).toEqual(['a', 'c'])
    expect(fresh).toEqual(['b'])
  })

  it('handles fully-fresh and fully-known scopes', () => {
    expect(partitionByKnown(['a'], new Set())).toEqual({ known: [], fresh: ['a'] })
    expect(partitionByKnown(['a'], new Set(['a']))).toEqual({ known: ['a'], fresh: [] })
  })
})
