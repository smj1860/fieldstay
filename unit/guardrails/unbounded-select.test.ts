import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { collectSourceFiles, rel, read, ROOT } from './scan'

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
// Scope is Inngest-REACHABLE code, not the lib/inngest/** DIRECTORY. That
// distinction is the fix for a real blind spot: the scan used to be
// collectSourceFiles(['lib/inngest']), which asks a filesystem question, while
// the property being enforced ("this select runs in a cron") is a reachability
// one. An unbounded read in a shared helper CALLED from a cron had exactly the
// same failure mode and was invisible — e.g.
// createGuidebookPropertyConfigsForProperties in lib/guidebook/sync.ts, called
// from three Inngest sync functions, doing an org-wide `.select('id, name')`
// with no bound and a discarded error.
//
// The reachable set is COMPUTED by following `@/lib/...` imports out of
// lib/inngest/**, never hand-listed. A curated list is the same blind spot with
// extra steps: correct the day it is written, silently wrong the first time
// someone adds an import.
//
// Still stops at lib/: app/ is a separate, larger ratchet, and "silently
// processes 1000 of N" is a correctness bug in a cron where it is often a
// pagination-UX question in a request handler.
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

/** Paginating helpers whose callback carries the bound. */
const PAGINATING_CALLERS = ['fetchAllRows', 'foldAllRows', 'fetchDistinctOrgIds']

/**
 * Is `idx` inside a paginating helper's callback, AND does that callback
 * actually paginate?
 *
 * The exemption exists because a conditionally-built query cannot satisfy the
 * chain scan:
 *
 *   let q = supabase.from('properties').select(…).eq(…)
 *   if (ids?.length) q = q.in('id', ids)
 *   return q.order('id').range(from, to)
 *
 * The `.range(` lands on a different expression than the `.from(`, so walking
 * forward from `.from(` never reaches it — yet the read IS bounded. Without
 * this, the conditional-build shape is unwritable under the rule.
 *
 * BUT the callback is not taken on trust. It must contain `.range(`, because
 * `fetchAllRows` with a callback that ignores its (from, to) does not paginate
 * at all — it re-requests the same first page until the maxRows ceiling throws.
 * Verified by canary: deleting `.range(from, to)` from a converted call site
 * must make this test fail, and with a bare "inside the callback" check it did
 * not.
 */
function insidePaginatingCall(src: string, idx: number): boolean {
  let depth = 0
  for (let i = idx; i >= 0; i--) {
    const ch = src[i]
    if (ch === ')') depth++
    else if (ch === '(') {
      if (depth > 0) { depth--; continue }
      // Generic helpers — every real call site passes a row type, e.g.
      // `fetchAllRows<{ id: string }>(`. Matching the bare identifier misses all of them.
      const before = src.slice(Math.max(0, i - 200), i)
      const isPaginator = PAGINATING_CALLERS.some(
        (fn) => new RegExp(`\\b${fn}\\s*(<[^()]*>)?\\s*$`).test(before),
      )
      if (!isPaginator) continue
      return callArgsText(src, i).includes('.range(')
    }
  }
  return false
}

/** Text between a call's opening paren and its matching close. */
function callArgsText(src: string, openParenIdx: number): string {
  let depth = 0
  for (let i = openParenIdx; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(openParenIdx, i + 1)
    }
  }
  return src.slice(openParenIdx)
}

/** `@/lib/foo/bar` -> `lib/foo/bar.ts` (or .tsx, or /index.ts), if it exists. */
function resolveLibImport(spec: string): string | null {
  if (!spec.startsWith('@/lib/')) return null
  const base = spec.slice(2)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(join(ROOT, candidate))) return candidate
  }
  return null
}

/**
 * Every lib module reachable from lib/inngest/** by following `@/lib/...`
 * imports transitively — the files whose `.select()` calls can actually run
 * inside a cron or event handler.
 */
function inngestReachableFiles(): string[] {
  const seeds = collectSourceFiles(['lib/inngest']).map((f) => rel(f))
  const seen  = new Set(seeds)
  const queue = [...seeds]

  while (queue.length) {
    const current = queue.pop()!
    for (const m of read(join(ROOT, current)).matchAll(/from\s+'(@\/lib\/[^']+)'/g)) {
      const resolved = resolveLibImport(m[1]!)
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved)
        queue.push(resolved)
      }
    }
  }

  return [...seen].sort()
}

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

/** The scan itself, over one source string — extracted so it can be run
 *  against a synthetic fixture as a POSITIVE CONTROL. See the sanity test. */
function offendersInSource(src: string, relPath: string): string[] {
  const offenders: string[] = []
  const FROM = /\.from\(\s*['"][a-z_]+['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = FROM.exec(src))) {
    const chain = extractChain(src, m.index)
    const selectIdx = chain.indexOf('.select(')
    if (selectIdx === -1) continue
    const beforeSelect = chain.slice(0, selectIdx)
    if (WRITE_VERBS.some((verb) => beforeSelect.includes(verb))) continue
    if (BOUNDED.some((token) => chain.includes(token))) continue
    if (insidePaginatingCall(src, m.index)) continue
    offenders.push(`${relPath}:${src.slice(0, m.index).split('\n').length}`)
  }
  return offenders
}

function findOffenders(): string[] {
  return inngestReachableFiles().flatMap((relPath) =>
    offendersInSource(read(join(ROOT, relPath)), relPath))
}

// Files that predate this rule. SHRINK-ONLY — never add an entry. Clearing one
// means auditing every read-path select in that file: paginate it via
// fetchAllRows, scope it per-org behind a fan-out event, bound it with an
// explicit .limit() plus documented "continue next run" semantics, or replace
// it with a count/RPC aggregate.
const BASELINE = new Set<string>([
  'lib/inngest/functions/auto-assign-vendor.ts',
  'lib/inngest/functions/hospitable/teammate-sync-handler.ts',
])

describe('guardrail: no unbounded .select() in lib/inngest/**', () => {
  const offenders = findOffenders()

  // POSITIVE CONTROL, replacing the old "population > N" floor.
  //
  // That floor existed to catch the scan breaking and reading as "all clean",
  // and it worked while the population was large — it was walked down 20 → 12
  // → 10 → 5 as files were genuinely fixed. But it is self-limiting: with 3
  // offenders left it would have to become "> 2", then "> 0", and at zero it
  // cannot distinguish a clean tree from a broken matcher at all — the exact
  // failure CLAUDE.md names for a semgrep rule sitting at 0.
  //
  // Running the scan against a synthetic known-bad source proves it still
  // fires at ANY population, including none. The negatives matter as much:
  // if the matcher started flagging bounded reads, the baseline would grow
  // and this suite would read as a regression rather than a broken scan.
  it('FIRES on a synthetic unbounded select (the scan is not silently broken)', () => {
    const bad = `const r = await supabase.from('bookings').select('id').eq('org_id', orgId)`
    expect(offendersInSource(bad, 'synthetic.ts')).toHaveLength(1)
  })

  it('does NOT fire on bounded, paginated, or write-returning selects', () => {
    const limited   = `const r = await supabase.from('bookings').select('id').eq('org_id', o).limit(10)`
    const single    = `const r = await supabase.from('bookings').select('id').eq('id', i).maybeSingle()`
    const counted   = `const r = await supabase.from('bookings').select('id', { count: 'exact', head: true })`
    const writeBack = `const r = await supabase.from('bookings').insert(rows).select('id')`
    for (const src of [limited, single, counted, writeBack]) {
      expect(offendersInSource(src, 'synthetic.ts')).toEqual([])
    }
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
