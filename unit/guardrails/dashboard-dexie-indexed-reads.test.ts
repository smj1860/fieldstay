import { describe, expect, it } from 'vitest'

import { collectSourceFiles, readCode, rel, ROOT } from './scan'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// A DEXIE orderBy() OR where() ON AN UNINDEXED KEY THROWS AT RUNTIME.
//
// `db.properties.orderBy('name')` compiled, passed type-checking and shipped,
// because Dexie's typings accept any string. The dashboard `properties` store is
// declared `'id, org_id'`, so every visit to /maintenance/inspections threw a
// SchemaError ("KeyPath name on object store properties is not indexed"), the
// route's error boundary caught it, and the first OwnerRez customer saw a broken
// page on their first day.
//
// So the index list in lib/dexie/dashboard/schema.ts is the contract, and this
// reads it: every `.orderBy('key')` / `.where('key')` on a dashboard table must
// name the primary key or a declared index. Sorting rows in memory (as the
// inspections list already does) is the alternative where an index is not worth
// a schema upgrade that every device has to go through.
// ============================================================================

const SCHEMA = 'lib/dexie/dashboard/schema.ts'

/** table -> every key a read may name, across every `version(n).stores({...})` block. */
export function declaredIndexes(schemaSrc: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const blocks = schemaSrc.matchAll(/\.stores\(\{([\s\S]*?)\}\)/g)
  for (const block of blocks) {
    for (const [, table, spec] of (block[1] ?? '').matchAll(/(\w+)\s*:\s*'([^']*)'/g)) {
      if (table === undefined || spec === undefined) continue
      const keys = out.get(table) ?? new Set<string>()
      for (const part of spec.split(',')) {
        // `++id` auto-increment, `&email` unique, `*tags` multi-entry: the name is what a read uses.
        const name = part.trim().replace(/^(\+\+|&|\*)/, '')
        if (name) keys.add(name)
      }
      out.set(table, keys)
    }
  }
  return out
}

export interface UnindexedRead { table: string; key: string; index: number }

/** Every `db.<table>.orderBy|where('<key>')` whose key is not declared for that table. */
export function findUnindexedReads(src: string, indexes: Map<string, Set<string>>): UnindexedRead[] {
  const found: UnindexedRead[] = []
  for (const m of src.matchAll(/\bdb\.(\w+)\.(?:orderBy|where)\(\s*['"]([^'"]+)['"]/g)) {
    const table = m[1] ?? ''
    const key   = m[2] ?? ''
    const known = indexes.get(table)
    // Not a dashboard table (e.g. a crew `db` in some other file): not ours to judge.
    if (!known) continue
    if (!known.has(key)) found.push({ table, key, index: m.index ?? 0 })
  }
  return found
}

const schemaSrc = readFileSync(join(ROOT, SCHEMA), 'utf8')
const indexes   = declaredIndexes(schemaSrc)

// Files that read the dashboard database: they say so by name.
function dashboardReaders(): string[] {
  return collectSourceFiles(['app', 'components', 'lib'])
    .filter((f) => /getDashboardDb|lib\/dexie\/dashboard/.test(readCode(f)) || rel(f).startsWith('lib/dexie/dashboard/'))
}

describe('dashboard Dexie reads only name indexed keys', () => {
  it('parses the real schema (so a broken parser cannot pass this vacuously)', () => {
    expect(indexes.get('properties')).toEqual(new Set(['id', 'org_id']))
    expect(indexes.get('inspections')?.has('completed_at')).toBe(true)
    expect(indexes.get('mutations')?.has('failed')).toBe(true)
  })

  it('FIRES on the shipped bug and not on a correct read', () => {
    const bad  = "const x = useLiveQuery(() => db.properties.orderBy('name').toArray(), [db], [])"
    const good = "const x = useLiveQuery(() => db.properties.orderBy('org_id').toArray(), [db], [])"
    expect(findUnindexedReads(bad, indexes).map((r) => `${r.table}.${r.key}`)).toEqual(['properties.name'])
    expect(findUnindexedReads(good, indexes)).toEqual([])
  })

  it('finds the readers it is supposed to scan', () => {
    expect(dashboardReaders().length).toBeGreaterThan(5)
  })

  it('no orderBy()/where() in the dashboard code names an unindexed key', () => {
    const offenders = dashboardReaders().flatMap((file) =>
      findUnindexedReads(readCode(file), indexes).map((r) => `${rel(file)}: ${r.table}.${r.key}`))
    expect(offenders).toEqual([])
  })
})
