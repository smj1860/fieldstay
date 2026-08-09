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

/**
 * Does `token` appear in the collection's defining EXPRESSION, rather than
 * merely in the name being declared?
 *
 * findDefinition slices from `const <name> =`, so the declaration itself is
 * part of the string being searched — and a collection called `orgIds`
 * contains the bound token `orgId` in its own name. Every plural-of-a-bound-
 * token variable therefore self-satisfied the check.
 *
 * That is not hypothetical: it is exactly how
 * platform-inventory-template-broadcast.ts kept `for (const orgId of orgIds)
 * { await step.run(...) }` over a platform-wide org scan, in the one cron the
 * 2026-07-30 fan-out pass missed, with this guardrail green the whole time.
 * A scalability audit found it by reading the code; this test could not.
 *
 * Fix: search only to the RIGHT of the `=`. A token in the initialiser is
 * evidence about the collection's size; a token in its name is evidence about
 * nothing.
 */
function initialiserOf(definition: string, name: string): string {
  const eq = definition.indexOf('=', definition.indexOf(name) + name.length)
  return eq === -1 ? definition : definition.slice(eq + 1)
}

function boundBy(definition: string, name: string, token: string): boolean {
  return initialiserOf(definition, name).includes(token)
}

/**
 * Is this collection bounded — directly, or because it is DERIVED from one
 * that is?
 *
 * A filter/map/slice of an org-scoped set is org-scoped. Without this,
 * narrowing a bounded collection before the fan-out loop — which is the
 * cheapest possible fix for a step explosion, since the loop then runs once
 * per unit of work rather than once per row examined — makes the guardrail go
 * RED, and the path of least resistance becomes inlining the filter back into
 * the loop body. A check that punishes the fix teaches people to skip it.
 *
 * One rule, applied transitively with a visited set so a self-reference or a
 * mutual pair cannot spin.
 */
function isBounded(src: string, name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false
  seen.add(name)

  const definition = findDefinition(src, name)
  // No local definition (a parameter, an import, a destructured event payload)
  // — the size is not decidable here, so don't guess.
  if (!definition) return false
  if (BOUND_TOKENS.some((t) => boundBy(definition, name, t))) return true

  // Every other identifier the initialiser mentions. If any of them is a
  // bounded local collection, this one inherits the bound.
  const initialiser = initialiserOf(definition, name)
  const referenced  = new Set(initialiser.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])
  referenced.delete(name)

  return Array.from(referenced).some((ref) => isBounded(src, ref, seen))
}

/**
 * Tokens in a collection's defining expression that make its size visibly
 * bounded.
 *
 * `org_id` is NOT one of them, and that is deliberate: a bare `org_id` also
 * matches `.select('org_id')` and `{ label: 'x.org_id' }`, which is what a
 * PLATFORM-WIDE tenant scan looks like — the exact opposite of a tenant scope.
 * `fetchDistinctOrgIds(from => supabase.from(t).select('org_id').range(...))`
 * self-certified as bounded on that substring alone. Only a filter (`.eq`,
 * `.in`) or the resolved JS variable counts.
 */
const BOUND_TOKENS = [
  ".eq('org_id'",  // scoped to one tenant (the fan-out unit)
  '.eq("org_id"',
  'orgId',         // the resolved id, as passed to that filter
  '.limit(',       // explicit cap, normally with "continue next run" semantics
  'BATCH',         // an explicitly chunked page
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

/**
 * Blank out comments, preserving byte offsets so reported line numbers stay
 * correct.
 *
 * The scan reads raw source, so it matched loop syntax written inside a
 * COMMENT — the fan-out fix for platform-inventory-template-broadcast.ts
 * documents the old `for (const orgId of orgIds) { await step.run(...) }` in
 * prose explaining why it is gone, and that prose was reported as the
 * offender. A guardrail that flags the documentation of the very defect it
 * guards teaches people to delete the explanation.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let inString: string | null = null

  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]

    if (inString) {
      if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (ch === inString) inString = null
      out += ch; i++; continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; out += ch; i++; continue }

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (ch === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '; i += 2; continue
    }
    out += ch; i++
  }
  return out
}

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const file of collectSourceFiles(['lib/inngest'])) {
    const src = stripComments(read(file))
    LOOP_OPEN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LOOP_OPEN.exec(src))) {
      const iterated = m[1] ?? m[2]
      if (!iterated) continue
      const body = findBodyAfter(src, LOOP_OPEN.lastIndex)
      if (!body || !FANOUT.test(body)) continue

      const name = rootIdentifier(iterated)
      if (!name) continue
      if (!findDefinition(src, name)) continue
      if (isBounded(src, name)) continue

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
  'lib/inngest/functions/hospitable/initial-sync.ts:136':
    'Bounded by one org\'s property count — this whole function is already per-org (`event.data.org_id`), and `propertyIds` comes from that org\'s just-synced properties (10-50 per CLAUDE.md\'s target user). The org scope lives on the function trigger rather than in the collection\'s defining expression, which is why the scan cannot see it.',
  'lib/inngest/functions/hospitable/initial-sync.ts:218':
    'Bounded by INITIAL_SYNC_LOOKAHEAD_MONTHS — `windows` is a fixed-length list of reservation date windows computed from a constant, not a query result. One step per window is the intended per-window retry boundary.',
  // The two REAL GAP entries that used to sit here (capex-projections.ts and
  // depreciation-ledger.ts, both one step.run per org over a platform-wide
  // scan) were deleted because the code was fixed, not because the check was
  // relaxed: both crons are now dispatcher + per-org handler pairs
  // (`org/capex_projection.requested`, `org/depreciation_ledger.requested`)
  // with `concurrency: { limit: 10 }`, matching the six converted in the
  // 2026-07-30 pass.

  'lib/inngest/functions/flagged-turnover-wo.ts:102':
    'Bounded by one org\'s PM count — a per-event handler whose `managers` is `getPmMembers(supabase, org_id, { roles: [...] })`. The org scope is a JS ARGUMENT here, which the scan cannot tell apart from the identically-named column in a `.select(\'id, org_id, ...\')` list, so no token can express it. Team size, not tenant count.',

  // ── The four REAL GAPS this test surfaced on 2026-08-09, now closed ──────
  //
  // Not new code and not newly broken when they appeared here: newly VISIBLE.
  // All four were passing because `org_id` used to be a BOUND_TOKEN, and
  // `.select('org_id')` — the literal signature of a platform-wide tenant scan
  // — contains it. The token that was supposed to mean "scoped to one tenant"
  // was satisfied by the opposite. Same hole that hid
  // platform-inventory-template-broadcast.ts until an external scalability
  // audit read the code; the previous fix (search only right of the `=`)
  // closed one instance, the substring itself was the hole.
  //
  // They are listed here as prose rather than as entries because the code is
  // fixed, not because the check was relaxed:
  //   - vendor-compliance-grace-check.ts — the per-document hard-block claim
  //     is now one bulk optimistic-locked UPDATE per 500 documents.
  //   - guidebook-daily-monitor.ts       -> guidebookDailyMonitorOrg
  //   - guidebook-stay-extension-cron.ts -> guidebookStayExtensionOrg
  //   - ownerrez-reviews-sync.ts         -> ownerRezReviewsSyncConnection
  // The last three are dispatcher + per-tenant-handler pairs with
  // `concurrency: { limit: 10 }`, matching the eight converted before them.
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
