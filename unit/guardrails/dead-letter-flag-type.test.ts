import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// NO OUTBOX MAY WRITE A BOOLEAN `failed`.
//
// IndexedDB has no boolean key type. A record whose indexed property holds
// `true` is simply OMITTED from that index — so a boolean `failed` cannot be
// indexed at all, and every dead-letter query silently degrades to a full scan
// of the outbox on every write to it. Three of those queries are `useLiveQuery`s
// that FailedSyncBanner keeps live on every crew screen, over a table written
// on every checklist tick.
//
// CLAUDE.md has stated this rule since the crew surface paid for it — twice,
// in two separate schema upgrades that had to normalise already-written rows
// (lib/dexie/schema.ts versions 9 and 10). It had no mechanical check, and the
// SHARED `outboxEngine.ts` had drifted straight back to `failed?: boolean` /
// `patch(id, { failed: true })`.
//
// That was not yet a live bug — the vendor portal is the only surface on that
// engine and its `mutations` table does not index `failed` — but it was a trap
// laid directly in the path of the next surface. docs/INSPECTIONS_SPEC.md §8
// puts the dashboard on this engine, its dead-letter banner needs an indexed
// query for exactly the reason above, and following the shared type would have
// produced a silently empty index. A convention worth writing down twice is
// worth enforcing once.
//
// Truthiness checks (`!m.failed`, `!!m.failed`) are unaffected and are not what
// this scans for. Only literal boolean WRITES.
// ============================================================================

const ROOTS = ['lib/dexie', 'app/crew', 'app/work-orders']

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${entry}`
    if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...walk(rel))
    else if (/\.tsx?$/.test(entry)) out.push(rel)
  }
  return out
}

/** Comments describe the rule; they are not violations of it. */
function stripComments(src: string): string {
  let inBlock = false
  return src.split('\n').map((line) => {
    const t = line.trim()
    if (inBlock) { if (t.includes('*/')) inBlock = false; return '' }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return '' }
    if (t.startsWith('//') || t.startsWith('*')) return ''
    return line.replace(/\/\/.*$/, '')
  }).join('\n')
}

// `failed: true` / `failed = false` / `failed?: boolean`, in a write or a type.
// `reported` is the same flag shape on crew_sync_incidents (Record Guarantee
// sync-incident reporting, RECORD_GUARANTEE_IMPLEMENTATION.md section 1.2) —
// same IndexedDB no-boolean-key-type rule, so the same regex covers both.
const BOOLEAN_FLAG = /\b(failed|reported)\s*[?]?\s*[:=]\s*(true|false|boolean)\b/

describe('guardrail: the dead-letter flag is 0 | 1, never a boolean', () => {
  const files = ROOTS.flatMap(walk)

  it('no outbox module declares or writes a boolean `failed`', () => {
    const offenders: string[] = []
    for (const file of files) {
      const code = stripComments(readFileSync(join(process.cwd(), file), 'utf8'))
      code.split('\n').forEach((line, i) => {
        if (BOOLEAN_FLAG.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`)
      })
    }

    expect(offenders, [
      'A dead-letter flag is declared or written as a boolean.',
      '',
      'IndexedDB has no boolean key type: a record holding `true` is omitted',
      'from the index entirely, so the flag cannot be indexed and every',
      'dead-letter query full-scans the outbox — including the live queries on',
      'every crew screen.',
      '',
      'Use DeadLetterFlag (0 | 1) from lib/dexie/outbox-primitives. Truthiness',
      'checks (`!m.failed`) keep working unchanged; only the literal write moves.',
      '',
      ...offenders.map((o) => `  ${o}`),
    ].join('\n')).toEqual([])
  })

  it('the shared primitives module has no imports, so any surface can use it', () => {
    // The reason this file exists at all. `outboxEngine.ts` used to reach into
    // `syncService.ts` — the 982-line CREW engine, which constructs a Supabase
    // client at class level — for six lines of backoff arithmetic. "Use the
    // shared engine" therefore meant "import the crew sync layer", which is
    // what makes a fourth surface look easier to fork than to join, and §8 of
    // the inspections spec is explicit that forking is the thing to avoid.
    const src = readFileSync(join(process.cwd(), 'lib/dexie/outbox-primitives.ts'), 'utf8')
    const imports = [...stripComments(src).matchAll(/^\s*import\s/gm)]
    expect(imports.length, 'outbox-primitives must stay a leaf module').toBe(0)
  })

  it('the shared engine does not import the crew sync layer', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'lib/dexie/outboxEngine.ts'), 'utf8'))
    for (const crewOnly of ['./syncService', './schema', './context']) {
      expect(src.includes(`from '${crewOnly}'`), [
        `outboxEngine.ts imports ${crewOnly}, a crew-surface module.`,
        'The engine is shared by the crew PWA, the vendor portal and (per',
        'INSPECTIONS_SPEC §8) the dashboard. Anything it needs belongs in',
        'outbox-primitives.ts, not in one surface\'s module.',
      ].join('\n')).toBe(false)
    }
  })

  it('SELF-CHECK: the scan reads real files and the matcher fires', () => {
    // A guardrail at zero because it globbed nothing looks exactly like one at
    // zero because the tree is clean.
    expect(files.length, 'no outbox files found — have the directories moved?').toBeGreaterThan(20)
    expect(files).toContain('lib/dexie/outboxEngine.ts')
    expect(files).toContain('lib/dexie/schema.ts')

    expect(BOOLEAN_FLAG.test('await this.patch(id, { failed: true })')).toBe(true)
    expect(BOOLEAN_FLAG.test('  failed?:    boolean')).toBe(true)
    expect(BOOLEAN_FLAG.test('db.mutations.update(id, { failed: false })')).toBe(true)
    // …and does NOT fire on the forms the rule permits.
    expect(BOOLEAN_FLAG.test('await this.patch(id, { failed: 1 })')).toBe(false)
    expect(BOOLEAN_FLAG.test('  failed?:    DeadLetterFlag')).toBe(false)
    expect(BOOLEAN_FLAG.test('.filter((m) => !m.failed)')).toBe(false)
    expect(BOOLEAN_FLAG.test('if (state.failed) setDeadLetterReason(x)')).toBe(false)
  })
})
