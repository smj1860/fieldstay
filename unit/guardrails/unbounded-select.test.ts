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
// The rule: inside lib/inngest/**, every `.select()` must be explicitly
// bounded — `.limit()`, `.range()` (i.e. paginated, normally via
// lib/inngest/paginate.ts's fetchAllRows), `.single()`/`.maybeSingle()`, or a
// `count`/`head` aggregate that ships no rows at all. Anything else is either
// fixed or listed in EXCEPTIONS with a reason for why its result set is
// bounded by something other than the query text (a small fixed reference
// table, a `.eq()` on a unique-ish column, etc.).
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

// Verified against the codebase 2026-07-30, immediately after the pre-launch
// scalability pass. Every entry is a select whose result set is bounded by
// something the query text cannot express. Adding one is a review event: state
// WHY the row count cannot exceed the cap, not merely that it is unlikely to.
const EXCEPTIONS: Record<string, string> = {}

describe('guardrail: no unbounded .select() in lib/inngest/**', () => {
  const offenders = findOffenders()

  it('every .select() is bounded, or a named justified exception', () => {
    const unlisted = offenders.filter((o) => !EXCEPTIONS[o])

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
        'If the result set is genuinely bounded by something the query text',
        'cannot express, add it to EXCEPTIONS in this test with that reason.',
        'Offenders:',
        ...unlisted,
      ].join('\n')
    ).toEqual([])
  })

  it('every EXCEPTIONS entry still exists at that file:line (prune when code moves)', () => {
    const present = new Set(offenders)
    for (const key of Object.keys(EXCEPTIONS)) {
      expect(
        present.has(key),
        `EXCEPTIONS lists ${key}, which is no longer an unbounded select — remove the stale entry.`
      ).toBe(true)
    }
  })
})
