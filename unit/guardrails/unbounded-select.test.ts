import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Unbounded-`.select()` guardrail for lib/inngest/**.
//
// supabase/config.toml sets `max_rows = 1000` (also the Supabase cloud
// default). PostgREST enforces it on EVERY response: a `.select()` matching
// more rows than the cap returns the first 1000 with a 200, no error, and no
// truncation signal of any kind. The failure mode is therefore not an
// exception a retry could surface — it is a silently wrong result set.
//
// That is fine in a request handler rendering one org's page. It is not fine
// in an Inngest cron, where a single unbounded platform-wide scan means the
// tenants sorted past row 1000 simply stop being processed. The 2026-07-30
// pre-launch audit found this in eight separate cron paths at once: iCal feed
// fan-out (feeds beyond the cap never received booking updates again), asset
// health scoring (~98% of assets frozen at a stale score), the metrics
// snapshot (gauges flat-lining at an arbitrary fraction of reality), the
// Kroger cart builder (below-par items past the cap never ordered), the
// notification digest, priority decay, crew scoring, and the stale-feed alert.
//
// The rule: inside lib/inngest/**, every read-path `.select()` must be
// explicitly bounded — `.limit()`, `.range()` (i.e. paginated, normally via
// lib/inngest/paginate.ts's fetchAllRows), `.single()`/`.maybeSingle()`, or a
// `count`/`head` aggregate that ships no rows at all.
//
// This is a clean-baseline ratchet, the same model as tailwind-color-ratchet:
// files that predate the rule are listed in BASELINE and grandfathered as a
// whole, but every file NOT in BASELINE — which includes all thirteen files
// the 2026-07-30 pass fixed — must stay clean forever. The baseline is
// SHRINK-ONLY: a file that becomes clean must be removed from it (enforced
// below), and nothing may ever be added. Keying the baseline by FILE rather
// than file:line is deliberate: line-keyed entries churn on every unrelated
// edit to a 700-line sync function, which trains people to "fix" the guardrail
// by bumping numbers instead of reading it.
//
// Scope is lib/inngest/** because that is where "silently processes 1000 of N"
// is a correctness bug rather than a pagination-UX question. Widening it to
// app/ is a separate, larger ratchet.
// ============================================================================

const BOUNDED = [
  '.limit(',
  '.range(',
  '.single(',
  '.maybeSingle(',
  'count:',
  'head:',
]

// `.update(...).select('id')` / `.delete().select('id')` is a RETURNING clause
// listing the rows the write itself touched, not a scan — the write's own
// filters bound it. Only a read-path `.select()` is in scope here.
const WRITE_VERBS = ['.insert(', '.update(', '.upsert(', '.delete(']

/**
 * Extract the full method-chain text starting at a `.from(` call: walk forward
 * balancing brackets and string literals, and stop at the first top-level `)`
 * that is not followed by another `.method(`.
 */
function extractChain(src: string, fromIdx: number): string {
  let i = fromIdx
  let depth = 0
  let inString: string | null = null

  while (i < src.length) {
    const ch = src[i]!
    const prev = src[i - 1]

    if (inString) {
      if (ch === inString && prev !== '\\') inString = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; i++; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      i++
      if (depth === 0) {
        // Chain continues only if the next non-whitespace/comment char is '.'
        let k = i
        while (k < src.length) {
          const c = src[k]!
          if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { k++; continue }
          if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k) + 1 || src.length; continue }
          break
        }
        if (src[k] === '.') { i = k; continue }
        return src.slice(fromIdx, i)
      }
      continue
    }
    i++
  }
  return src.slice(fromIdx)
}

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const file of collectSourceFiles(['lib/inngest'])) {
    const src = read(file)
    const FROM = /\.from\(\s*['"][a-z_]+['"]\s*\)/g
    let m: RegExpExecArray | null
    while ((m = FROM.exec(src))) {
      const chain = extractChain(src, m.index)
      const selectIdx = chain.indexOf('.select(')
      if (selectIdx === -1) continue
      const beforeSelect = chain.slice(0, selectIdx)
      if (WRITE_VERBS.some((verb) => beforeSelect.includes(verb))) continue
      if (BOUNDED.some((token) => chain.includes(token))) continue
      offenders.push(`${rel(file)}:${src.slice(0, m.index).split('\n').length}`)
    }
  }
  return offenders
}

// Files that predate this rule. SHRINK-ONLY — never add an entry. Clearing one
// means auditing every read-path select in that file: paginate it via
// fetchAllRows, scope it per-org behind a fan-out event, bound it with an
// explicit .limit() plus documented "continue next run" semantics, or replace
// it with a count/RPC aggregate.
const BASELINE = new Set<string>([
  'lib/inngest/functions/auto-assign-turnover.ts',
  'lib/inngest/functions/auto-assign-vendor.ts',
  'lib/inngest/functions/checklist-broadcast.ts',
  'lib/inngest/functions/crew-assignment.ts',
  'lib/inngest/functions/cron/daily-wrapup.ts',
  'lib/inngest/functions/flagged-turnover-wo.ts',
  'lib/inngest/functions/hospitable/calendar-sync-handler.ts',
  'lib/inngest/functions/hospitable/hospitable-reviews-backfill.ts',
  'lib/inngest/functions/hospitable/initial-sync.ts',
  'lib/inngest/functions/hospitable/property-merge.ts',
  'lib/inngest/functions/hospitable/teammate-sync-handler.ts',
  'lib/inngest/functions/hostaway/initial-sync.ts',
  'lib/inngest/functions/inventory-events.ts',
  'lib/inngest/functions/ownerrez/incremental-sync.ts',
  'lib/inngest/functions/ownerrez/initial-sync.ts',
  'lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts',
  'lib/inngest/functions/ownerrez/reconciliation-handler.ts',
  'lib/inngest/functions/platform-inventory-template-broadcast.ts',
])

describe('guardrail: no unbounded .select() in lib/inngest/**', () => {
  const offenders = findOffenders()

  it('finds the select population (sanity: the scan is not silently empty)', () => {
    expect(offenders.length).toBeGreaterThan(20)
  })

  it('no unbounded .select() outside the grandfathered baseline files', () => {
    const unlisted = offenders.filter((o) => !BASELINE.has(o.split(':')[0]!))

    expect(
      unlisted,
      [
        'An unbounded .select() was found in lib/inngest/**. PostgREST caps',
        'every response at max_rows (1000, see supabase/config.toml) with NO',
        'error and no truncation signal — so this silently processes at most',
        '1000 rows and stops covering the platform as tenant count grows.',
        '',
        'Fix it by paginating (fetchAllRows from lib/inngest/paginate.ts,',
        'which drains .range() pages), scoping the query per-org and fanning',
        'out one event per tenant (see cron/daily-wrapup.ts), adding an',
        'explicit .limit() with documented "continue next run" semantics, or',
        'replacing the scan with a count/RPC aggregate that ships no rows.',
        '',
        'Do NOT add the file to BASELINE — that list is shrink-only.',
        'Offenders:',
        ...unlisted,
      ].join('\n')
    ).toEqual([])
  })

  it('BASELINE only lists files that still have an unbounded select (shrink-only ratchet)', () => {
    const offendingFiles = new Set(offenders.map((o) => o.split(':')[0]!))
    const clean = [...BASELINE].filter((f) => !offendingFiles.has(f))

    expect(
      clean,
      [
        'These files are in BASELINE but now have zero unbounded selects.',
        'Remove them — the baseline is shrink-only, and leaving a cleaned file',
        'in it silently re-permits the bug it was just fixed for. Files:',
        ...clean,
      ].join('\n')
    ).toEqual([])
  })
})
