import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeAdvancedCursor, partitionByKnown, CURSOR_OVERLAP_MS, SYNC_CURSOR_KEYS,
} from '@/lib/dexie/sync/cursors'

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

// ============================================================================
// Two lists describe the delta cursors, and they answer DIFFERENT questions:
//
//   SYNC_CURSOR_KEYS            — every cursor that exists.
//   CURSORS_BY_MUTATION_TABLE   — which cursors guard the table a given
//                                 ABANDONED MUTATION targets.
//
// The second is strictly smaller, and conflating them is the trap. A cursor
// gating a cache the crew only ever READS has no mutation table pointing at
// it, so building resetAllCursors() out of the mutation map would silently
// leave exactly that cursor un-reset — inside the one function whose whole
// purpose is repairing a device whose cache has diverged.
//
// The map itself is now a TOTAL Record<MutationTable, …>, so a new
// MutationTable is a compile error rather than a silent omission. That matters
// because the consequence of an omission has no symptom: invalidateCursorsFor
// is what stops an abandoned mutation leaving the local cache pinned to a
// value the server never accepted, permanently, with nothing in any log.
// Verified by deliberately adding a 9th union member — with the total Record
// tsc reports "Property 'crew_signatures' is missing" at this map; with the
// Partial it previously compiled with zero errors.
// ============================================================================
describe('cursor bookkeeping covers every cursor and every mutation table', () => {
  it('every cursor a pull site actually uses is in SYNC_CURSOR_KEYS', () => {
    const used = new Set<string>()
    for (const file of ['turnovers.ts', 'work-orders.ts', 'assets.ts', 'full-resync.ts', 'chunked.ts', 'scope.ts', 'signals.ts']) {
      const src = readFileSync(join(process.cwd(), 'lib/dexie/sync', file), 'utf8')
      for (const m of src.matchAll(/'(cursor:[a-z_]+)'/g)) used.add(m[1]!)
    }
    // Anything a pull reads or advances but resetAllCursors() does not clear
    // survives a full resync — which is how a diverged device stays diverged.
    expect([...used].sort().filter((k) => !(SYNC_CURSOR_KEYS as readonly string[]).includes(k))).toEqual([])
  })

  it('every MutationTable has an explicit cursor decision, empty or not', () => {
    const src = readFileSync(join(process.cwd(), 'lib/dexie/schema.ts'), 'utf8')
    const union = src
      .slice(src.indexOf('export type MutationTable ='))
      .split('\n\n')[0]!
      .match(/'([a-z_]+)'/g)!
      .map((q) => q.slice(1, -1))

    expect(union.length).toBeGreaterThan(0)

    // Read from source rather than exporting an internal constant purely to
    // be asserted on. The compiler already enforces totality; this states the
    // reason somewhere a reader will actually find it.
    const cursorSrc = readFileSync(join(process.cwd(), 'lib/dexie/sync/cursors.ts'), 'utf8')
    const mapBody = cursorSrc.slice(
      cursorSrc.indexOf('const CURSORS_BY_MUTATION_TABLE'),
      cursorSrc.indexOf('export async function invalidateCursorsFor'),
    )

    const missing = union.filter((table) => !new RegExp(`\\b${table}:`).test(mapBody))
    expect(
      missing,
      'These MutationTables have no entry in CURSORS_BY_MUTATION_TABLE. Add one — ' +
      'an empty array is fine, but it must say WHY the table needs no cursor ' +
      'rewind (not cached at all, vs. cached but pulled in full every time).',
    ).toEqual([])
  })
})
