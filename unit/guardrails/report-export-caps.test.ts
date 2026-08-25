import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ============================================================================
// THE INSPECTION EXPORT CAPS STAY IN STEP WITH CLAUDE.md.
//
// @smj1860, 2026-08-25: "let's just make sure the number is documented in
// Claude.md so no one forgets."
//
// Documenting it is half the job. A number written into prose and a number
// written into code drift the first time someone edits one of them, and the
// drift is invisible: the doc keeps reading confidently, CI keeps passing, and
// the next person plans against a figure that stopped being true. That is the
// same failure mode env-schema-coverage and node-types-runtime-parity exist
// for, so this is the same shape of check — two places must agree, and it
// fails in BOTH directions.
//
// It deliberately does NOT assert what the values SHOULD be. 60 is a judgment
// call about request-path CPU and it is allowed to change; what is not allowed
// is changing it in one place. Raising one is a capacity decision — see the
// CLAUDE.md section for why the answer past a few hundred walks is an Inngest
// job writing to Storage rather than a bigger constant.
// ============================================================================

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

/** Every cap the CLAUDE.md table names, and the module that owns it. */
const CAPS: { name: string; file: string }[] = [
  { name: 'MAX_HISTORY_INSPECTIONS', file: 'lib/inspections/report/model.ts' },
  { name: 'MAX_REPORT_PHOTOS',       file: 'lib/inspections/report/model.ts' },
  { name: 'MAX_ANSWER_ROWS',         file: 'lib/inspections/report/model.ts' },
  { name: 'MAX_INSPECTIONS',         file: 'lib/owner-portal/inspections.ts' },
  { name: 'MAX_ITEM_ROWS',           file: 'lib/owner-portal/inspections.ts' },
]

/**
 * The declared value, read from source text rather than imported.
 *
 * Importing would pull in `server-only` and a Supabase client for what is a
 * question about a literal. It also means a cap that stops being exported —
 * `MAX_ANSWER_ROWS` is module-private today — is still covered.
 */
function declaredValue(name: string, file: string): number {
  const src = read(file)
  const m = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([0-9_]+)`).exec(src)
  if (!m) throw new Error(`${name} is not declared in ${file}`)
  return Number(m[1]!.replace(/_/g, ''))
}

/**
 * Every number the CLAUDE.md table states against a cap's name.
 *
 * Matched on the ROW, so a value mentioned in the surrounding prose cannot
 * stand in for one missing from the table.
 */
function documentedValue(name: string): number | null {
  for (const line of read('CLAUDE.md').split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    if (!line.includes(`\`${name}\``)) continue
    // Bold, with or without thousands separators: **60**, **12,000**
    const m = /\*\*([0-9][0-9,]*)\*\*/.exec(line)
    if (m) return Number(m[1]!.replace(/,/g, ''))
  }
  return null
}

describe('guardrail: inspection export caps match CLAUDE.md', () => {
  it.each(CAPS)('$name is documented with its real value', ({ name, file }) => {
    const actual     = declaredValue(name, file)
    const documented = documentedValue(name)

    expect(
      documented,
      `${name} is declared in ${file} but has no row in the "Inspection export caps" `
      + 'table in CLAUDE.md. A cap nobody remembers is a cap somebody raises.',
    ).not.toBeNull()

    expect(
      documented,
      `${name} is ${actual} in ${file} but CLAUDE.md says ${documented}. `
      + 'Change both, in the same commit.',
    ).toBe(actual)
  })

  it('names the owning module for every cap, so the table is followable', () => {
    const doc = read('CLAUDE.md')
    for (const { name, file } of CAPS) {
      const row = doc.split('\n').find((l) => l.trimStart().startsWith('|') && l.includes(`\`${name}\``))
      expect(row, `no CLAUDE.md row for ${name}`).toBeDefined()
      expect(row, `${name}'s row must name ${file}`).toContain(file)
    }
  })

  it('documents no cap that no longer exists', () => {
    // The other direction, and the one a doc-only edit gets wrong. A row left
    // behind after its constant was deleted or renamed is worse than no row —
    // it reads as current.
    const doc   = read('CLAUDE.md')
    const known = new Set(CAPS.map((c) => c.name))

    const rows = doc.split('\n').filter((l) =>
      l.trimStart().startsWith('|') && /\*\*[0-9][0-9,]*\*\*/.test(l) && /`MAX_[A-Z_]+`/.test(l))

    for (const row of rows) {
      const name = /`(MAX_[A-Z_]+)`/.exec(row)![1]!
      expect(
        known.has(name),
        `CLAUDE.md documents ${name}, which is not in this test's CAPS list. `
        + 'Either it was renamed/removed and the row is stale, or it is a new cap '
        + 'that needs adding here.',
      ).toBe(true)
    }
  })
})

/**
 * Source with comments removed.
 *
 * WRITTEN AFTER THIS FILE'S OWN CANARY CAUGHT IT. The first version asserted
 * `read(model).toContain("count: 'exact'")` and passed happily with the count
 * deleted from the query — because the COMMENT above that query says
 * `count: 'exact'` too. A test satisfied by a comment describing the behaviour
 * is not testing the behaviour, and it fails in the direction that looks fine.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments, JSDoc included
    .replace(/(^|[^:])\/\/.*$/gm, '$1')  // line comments, sparing "https://"
}

describe('guardrail: a cap that applies is stated in the output', () => {
  it('the history read asks for an exact count, in CODE not in a comment', () => {
    // The rule the numbers exist to serve. Without the total there is no way to
    // distinguish "this is the whole record" from "this is the first page of
    // it", and an evidentiary document would assert the second as the first.
    expect(
      /\.select\(\s*INSPECTION_SELECT\s*,\s*\{\s*count:\s*'exact'\s*\}\s*\)/
        .test(code('lib/inspections/report/model.ts')),
      "the whole-property history read must pass { count: 'exact' } — "
      + 'MAX_HISTORY_INSPECTIONS cannot be stated without the total it is capping.',
    ).toBe(true)
  })

  it('omittedCount is derived from that count, not hardcoded', () => {
    const src = code('lib/inspections/report/model.ts')
    expect(src).toMatch(/omittedCount:\s*Math\.max\(/)
    expect(src, 'the total must come from the query result').toMatch(/res\.count\s*\?\?/)
  })

  it('the owner portal states its own cap the same way', () => {
    const src = code('lib/owner-portal/inspections.ts')
    expect(/\{\s*count:\s*'exact'\s*\}/.test(src)).toBe(true)
    expect(src).toMatch(/totalCompleted:\s*inspectionsRes\.count\s*\?\?/)
    expect(code('app/owner/[token]/inspection-history.tsx')).toContain('historySubtitle(')
  })

  it('the cover page has a note for the capped case', () => {
    expect(code('lib/inspections/report/content.ts')).toContain('historyCapNote')
    expect(code('lib/inspections/report/render.ts')).toContain('historyCapNote(')
  })
})
