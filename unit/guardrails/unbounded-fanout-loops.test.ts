import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Unbounded fan-out loop guardrail.
//
// `for (const row of rows) { await step.run(...) }` gives every item its own
// Inngest retry boundary, which is a good pattern — n-plus-one-loops.test.ts
// explicitly exempts it for that reason. But that exemption is only sound when
// `rows` is bounded. When it is a platform-wide query result, the same shape
// is a step explosion instead: at 150 tenants, cron/work-order-ops.ts was
// issuing 2 steps per aging work order plus up to 3 per due maintenance
// schedule from two serial loops in ONE invocation (~2,000+ steps, past
// Inngest's per-run ceiling), with the memoized-state payload re-sent on every
// step and a single failing tenant retrying the entire tail.
//
// That gap is exactly why findings 4, 5, 11 and 12 of the 2026-07-30
// pre-launch audit were invisible to CI: the n-plus-one check waved them
// through by design, and nothing else looked at how many iterations there
// could be. This test is the other half of that pair — n-plus-one-loops
// governs round-trips per row, this one governs how many rows there can be.
//
// The rule: if a loop body contains `step.run(` or `step.sendEvent(`, the
// collection it iterates must be visibly bounded at its definition — scoped to
// a single org (`org_id`/`orgId` appears in the defining expression), capped
// with an explicit `.limit()`, or a plainly finite literal/derived array. A
// platform-wide scan must be converted to a dispatcher that fans out one event
// per tenant (see cron/daily-wrapup.ts, and the six crons converted in the
// same pass) so step counts scale with one tenant, not the platform.
// ============================================================================

const LOOP_OPEN = /(?:for\s*(?:await\s*)?\(\s*(?:const|let)\s+(?:[\w$]+|\{[^}]*\}|\[[^\]]*\])\s+of\s+([^)]+?)\s*\)|\b([\w$.]+)\.forEach\()/g
const FANOUT = /step\.(run|sendEvent)\(/

/** Tokens in a collection's defining expression that make its size visibly bounded. */
const BOUND_TOKENS = [
  'org_id',       // scoped to one tenant (the fan-out unit)
  'orgId',
  '.limit(',      // explicit cap, normally with "continue next run" semantics
  'BATCH',        // an explicitly chunked page
  'slice(',
]

function findBodyAfter(src: string, searchFrom: number): string | null {
  const openIdx = src.indexOf('{', searchFrom)
  if (openIdx === -1) return null
  let depth = 0
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(openIdx, j + 1)
    }
  }
  return null
}

/** Root identifier of an iterated expression: `Object.entries(byOrg)` → `byOrg`, `rows` → `rows`. */
function rootIdentifier(expr: string): string | null {
  const trimmed = expr.trim()
  const wrapped = /^(?:Object\.(?:entries|keys|values)|Array\.from)\(\s*([\w$]+)/.exec(trimmed)
  if (wrapped) return wrapped[1]!
  const bare = /^([\w$]+)/.exec(trimmed)
  return bare ? bare[1]! : null
}

/** The defining expression for `const name = <expr>` / `let name = <expr>`, balanced to statement end. */
function findDefinition(src: string, name: string): string | null {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^=]*=`, 'g')
  const m = decl.exec(src)
  if (!m) return null

  let i = decl.lastIndex
  let depth = 0
  let inString: string | null = null
  for (; i < src.length; i++) {
    const ch = src[i]!
    if (inString) {
      if (ch === inString && src[i - 1] !== '\\') inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (depth === 0 && ch === '\n') {
      // Statement ends at a newline only when the expression is complete and
      // the next non-blank line starts a new statement rather than a chained
      // `.method(` continuation.
      const rest = src.slice(i + 1)
      if (!/^\s*[.?]/.test(rest)) break
    }
    if (depth < 0) break
  }
  return src.slice(m.index, i)
}

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const file of collectSourceFiles(['lib/inngest'])) {
    const src = read(file)
    LOOP_OPEN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LOOP_OPEN.exec(src))) {
      const iterated = m[1] ?? m[2]
      if (!iterated) continue
      const body = findBodyAfter(src, LOOP_OPEN.lastIndex)
      if (!body || !FANOUT.test(body)) continue

      const name = rootIdentifier(iterated)
      if (!name) continue

      const definition = findDefinition(src, name)
      // No local definition (a parameter, an import, a destructured event
      // payload) — the size is not decidable here, so don't guess.
      if (!definition) continue
      if (BOUND_TOKENS.some((t) => definition.includes(t))) continue

      offenders.push(`${rel(file)}:${src.slice(0, m.index).split('\n').length}`)
    }
  }
  return offenders
}

// Verified against the codebase 2026-07-30, after the fan-out conversion of
// ical-sync, cron/asset-health, cron/work-order-ops, cron/maintenance-schedules,
// cron/comms-retention and cron/guest-pii-retention. Each entry states why the
// iteration count is bounded by something the defining expression cannot show.
const EXCEPTIONS: Record<string, string> = {
  'lib/inngest/functions/hospitable/initial-sync.ts:133':
    'Bounded by one org\'s property count — this whole function is already per-org (`event.data.org_id`), and `propertyIds` comes from that org\'s just-synced properties (10-50 per CLAUDE.md\'s target user). The org scope lives on the function trigger rather than in the collection\'s defining expression, which is why the scan cannot see it.',
  'lib/inngest/functions/hospitable/initial-sync.ts:215':
    'Bounded by INITIAL_SYNC_LOOKAHEAD_MONTHS — `windows` is a fixed-length list of reservation date windows computed from a constant, not a query result. One step per window is the intended per-window retry boundary.',
  // The two REAL GAP entries that used to sit here (capex-projections.ts and
  // depreciation-ledger.ts, both one step.run per org over a platform-wide
  // scan) were deleted because the code was fixed, not because the check was
  // relaxed: both crons are now dispatcher + per-org handler pairs
  // (`org/capex_projection.requested`, `org/depreciation_ledger.requested`)
  // with `concurrency: { limit: 10 }`, matching the six converted in the
  // 2026-07-30 pass.
}

describe('guardrail: no step.run/step.sendEvent loop over an unbounded collection', () => {
  const offenders = findOffenders()

  it('every fan-out loop iterates a visibly bounded collection', () => {
    const unlisted = offenders.filter((o) => !EXCEPTIONS[o])

    expect(
      unlisted,
      [
        'A loop whose body calls step.run()/step.sendEvent() iterates a',
        'collection with no visible bound at its definition — no org scope,',
        'no .limit(), no explicit chunking. Step count therefore grows with',
        'the whole platform inside a single Inngest run, which blows the',
        'per-run step ceiling and makes one failing tenant retry everyone.',
        '',
        'Convert the cron to a dispatcher that fans out one event per org and',
        'move the loop into a per-org handler with its own concurrency cap',
        '(cron/daily-wrapup.ts is the reference shape), or bound the query',
        'with an explicit .limit() plus "continue next run" semantics.',
        '',
        'n-plus-one-loops.test.ts deliberately exempts the step.run-per-item',
        'shape; this test is what makes that exemption safe. Offenders:',
        ...unlisted,
      ].join('\n')
    ).toEqual([])
  })

  it('finds the fan-out loop population (sanity: the scan is not silently empty)', () => {
    // Every bounded fan-out loop in lib/inngest/** is examined and passes;
    // this asserts the matcher still sees loops at all, so a regex that stops
    // matching cannot masquerade as a clean result.
    let seen = 0
    for (const file of collectSourceFiles(['lib/inngest'])) {
      const src = read(file)
      LOOP_OPEN.lastIndex = 0
      while (LOOP_OPEN.exec(src) !== null) {
        const body = findBodyAfter(src, LOOP_OPEN.lastIndex)
        if (body && FANOUT.test(body)) seen++
      }
    }
    expect(seen).toBeGreaterThan(3)
  })

  it('every EXCEPTIONS entry still exists at that file:line (prune when code moves)', () => {
    const present = new Set(offenders)
    for (const key of Object.keys(EXCEPTIONS)) {
      expect(
        present.has(key),
        `EXCEPTIONS lists ${key}, which is no longer an unbounded fan-out loop — remove the stale entry.`
      ).toBe(true)
    }
  })
})
