import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// Guardrail: the drift gate's table map must stay parseable.
//
// scripts/check-type-drift.mjs learns which hand-written interface models which
// live table by REGEX-PARSING types/database.ts. That is fragile by nature, and
// it broke: the mapping used to be a side effect of the hand-written
// `Database.public.Tables` block, so when Database moved to
// types/database.generated.ts the block went with it, the regex matched
// nothing, and the gate reported all 92 live tables as unmodelled. It looked
// like catastrophic schema drift and was a parse miss.
//
// The script now fails loudly on an empty parse instead of emitting 92 bogus
// findings — but that only helps in the db-invariants job, which SELF-DISARMS
// when the Supabase secrets are absent (a fork PR, a local run). This test runs
// in the always-on `checks` job with no database at all, so a refactor that
// breaks the map is caught on the PR rather than at merge time.
//
// It deliberately duplicates the script's regex. If you change one, change both
// — that duplication is the point: it is what makes a silent divergence fail.
// ============================================================================

const TYPES = readFileSync(join(process.cwd(), 'types', 'database.ts'), 'utf8')
const SCRIPT = readFileSync(join(process.cwd(), 'scripts', 'check-type-drift.mjs'), 'utf8')

function parseMap(src: string): Record<string, string> {
  const block = src.match(/export interface HandWrittenRowMap \{([\s\S]*?)\n\}/)
  if (!block) return {}
  const map: Record<string, string> = {}
  for (const m of block[1].matchAll(/^\s+(\w+):\s*(\w+)\s*$/gm)) map[m[1]] = m[2]
  return map
}

describe('guardrail: check-type-drift.mjs can still parse the table map', () => {
  const map = parseMap(TYPES)

  it('parses a non-trivial number of table -> interface entries', () => {
    // A specific floor, not `> 0`: a regex that half-matches is as misleading
    // as one that matches nothing, and the failure mode being defended against
    // produced exactly zero.
    expect(Object.keys(map).length).toBeGreaterThan(80)
  })

  it('every mapped interface actually exists in types/database.ts', () => {
    const missing = Object.entries(map)
      .filter(([, iface]) => !TYPES.includes(`export interface ${iface} {`))
      .map(([table, iface]) => `${table} -> ${iface}`)
    expect(missing, `HandWrittenRowMap names interfaces that do not exist:\n  ${missing.join('\n  ')}`)
      .toEqual([])
  })

  it('the script still reads HandWrittenRowMap, not the moved Database block', () => {
    expect(
      SCRIPT.includes('HandWrittenRowMap'),
      'check-type-drift.mjs no longer references HandWrittenRowMap — if the map was ' +
        'renamed, update this guardrail too.',
    ).toBe(true)
    expect(
      SCRIPT.includes('Views:/'),
      'check-type-drift.mjs is parsing the old `Tables: { ... } Views:` block again. That ' +
        'block now lives in types/database.generated.ts, where diffing it against the live ' +
        'schema it was generated from can never fail.',
    ).toBe(false)
  })
})
