import { describe, it, expect } from 'vitest'
import { blankComments, collectSourceFiles, read, rel } from './scan'

// ============================================================================
// Webhook dedup claim/release guardrail.
//
// Every webhook route in this app dedups the same way: INSERT a claim row
// keyed on the delivery (a content hash, or Stripe's event.id) BEFORE running
// the handler, and treat a `23505` unique violation as "already processed,
// discard the retry". Claiming before the handler runs is deliberate — it is
// what makes two concurrent redeliveries collapse into one.
//
// The consequence nobody remembers on the second copy of the pattern: if the
// handler then THROWS, the claim is still sitting there. The provider retries,
// resends a byte-identical body, hashes/keys identically, hits the 23505
// branch — and the event is discarded as a duplicate even though nothing ever
// processed it. A real event is lost permanently, and the route returned a
// cheerful 200 on the way.
//
// The pre-launch audit (2026-07-30) found exactly this: the main Stripe route
// had been fixed, its comment even said it mirrored the generic provider
// route, and app/api/webhooks/stripe-connect/route.ts had been missed by that
// sweep and still never released its claim. On the Telnyx route the same gap
// would silently drop an inbound STOP — a TCPA compliance obligation.
//
// The rule: inside app/api/webhooks/**, a file that INSERTs into a dedup-claim
// table must also DELETE from that same table inside a `catch` block. The
// catch requirement is the load-bearing half — a delete on the happy path is
// not a release, it's a bug.
//
// This is the "non-Inngest write paths lacking dedup" item from CLAUDE.md's
// Manual Audit Checklist, narrowed to the one subset that is mechanically
// decidable. Whether an arbitrary Server Action is safe against a double
// submit is still a judgment call and stays in that checklist.
// ============================================================================

/**
 * A table whose name marks it as a dedup/idempotency claim ledger. Deliberately
 * a name heuristic rather than a fixed list, so a NEW claim table (a third
 * `*_processed_events`, say) is covered the day it appears instead of the day
 * someone remembers to update this file.
 */
const CLAIM_TABLE = /processed_webhooks|processed_events|_dedup(e)?$/

const FROM_CALL = /\.from\(\s*['"]([\w]+)['"]\s*\)/g

/** Slice from an opening `{` to its matching `}`; returns [start, end). */
function blockRange(src: string, openIndex: number): [number, number] {
  let depth = 1
  let i = openIndex + 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return [openIndex, i]
}

/** Character ranges of every `catch (...) { ... }` body in the file. */
function catchRanges(src: string): CatchRange[] {
  const ranges: CatchRange[] = []
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    ranges.push(blockRange(src, m.index + m[0].length - 1))
  }
  return ranges
}

/**
 * Offsets of every `.from('table')` call in `src` whose query chain — the
 * bounded window after it, which is what a PostgREST builder chain occupies —
 * contains `method`.
 */
function chainOffsets(src: string, table: string, method: 'insert' | 'delete'): number[] {
  const WINDOW = 300
  const hits: number[] = []
  const re = new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (src.slice(m.index, m.index + WINDOW).includes(`.${method}(`)) hits.push(m.index)
  }
  return hits
}

/**
 * `status: 4xx|5xx` — the provider is told the delivery failed, so it retries.
 * This is what makes a release meaningful.
 */
const RETRYABLE_STATUS = /status:\s*(?:4\d\d|5\d\d)/
/** An explicit 2xx — the provider records the delivery as succeeded. */
const SUCCESS_STATUS = /status:\s*2\d\d/

/**
 * Name of the function enclosing `offset`, by scanning back to the nearest
 * `function <name>(` declaration.
 *
 * A release extracted into a shared `releaseDedupClaim()` helper — which is
 * better code than the same delete copy-pasted into two catch blocks — would
 * otherwise read as "deletes outside a catch" and fail this guardrail. So a
 * release is satisfied EITHER by a delete sitting directly in a catch, OR by
 * a call to the helper that contains it sitting in a catch.
 */
function enclosingFunctionName(src: string, offset: number): string | null {
  const decl = /function\s+([A-Za-z_$][\w$]*)\s*\(/g
  let name: string | null = null
  let m: RegExpExecArray | null
  while ((m = decl.exec(src)) !== null && m.index < offset) name = m[1]!
  return name
}

/** Offsets of every call to `name(` in `src`. */
function callOffsets(src: string, name: string): number[] {
  const hits: number[] = []
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) hits.push(m.index)
  return hits
}

function claimTablesIn(src: string): string[] {
  const tables = new Set<string>()
  for (const m of src.matchAll(FROM_CALL)) {
    const table = m[1]!
    if (CLAIM_TABLE.test(table)) tables.add(table)
  }
  return [...tables]
}

export interface DedupViolation {
  file:   string
  table:  string
  reason: string
}

type CatchRange = [number, number]

/**
 * Offsets that count as "releasing the claim on a failure path": the delete
 * itself when it sits in a catch, plus any call to a helper function that
 * wraps the delete.
 */
function releaseSites(src: string, deletes: number[], inCatch: (o: number) => boolean): number[] {
  const sites = deletes.filter(inCatch)

  for (const d of deletes) {
    if (inCatch(d)) continue
    const helper = enclosingFunctionName(src, d)
    if (helper) sites.push(...callOffsets(src, helper).filter(inCatch))
  }
  return sites
}

/**
 * The half of the invariant this file used to state in prose without checking:
 * a release is only meaningful if the SAME catch also asks the provider to
 * redeliver. app/api/webhooks/[provider] released the claim and then returned
 * 200, so the provider recorded the delivery as successful and no retry ever
 * arrived to use the window the release had just opened — the event was lost
 * AND the dedup protection was dropped. A release paired with a 2xx is strictly
 * worse than no release at all.
 */
function pairingViolations(
  src: string, path: string, table: string, catches: CatchRange[], sites: number[],
): DedupViolation[] {
  const out: DedupViolation[] = []

  for (const [start, end] of catches) {
    if (!sites.some((r) => r > start && r < end)) continue
    const body = src.slice(start, end)

    if (!RETRYABLE_STATUS.test(body)) {
      out.push({ file: path, table,
        reason: `releases the ${table} claim in a catch that never returns 4xx/5xx — the provider treats the delivery as succeeded and never redelivers, so the release is dead code and the event is lost` })
    } else if (SUCCESS_STATUS.test(body)) {
      out.push({ file: path, table,
        reason: `releases the ${table} claim in a catch that can still return 2xx — a success response on the path that just dropped the claim loses the event` })
    }
  }
  return out
}

/** Every violation for one claim table in one file. */
function tableViolations(
  src: string, path: string, table: string, catches: CatchRange[],
): DedupViolation[] {
  if (chainOffsets(src, table, 'insert').length === 0) return []   // reader, not claimer

  const deletes = chainOffsets(src, table, 'delete')
  if (deletes.length === 0) {
    return [{ file: path, table,
      reason: `claims a dedup row in ${table} but never deletes it — a handler throw strands the claim and the provider's retry is discarded as a duplicate` }]
  }

  const inCatch = (offset: number) => catches.some(([s, e]) => offset > s && offset < e)
  const sites   = releaseSites(src, deletes, inCatch)
  if (sites.length === 0) {
    return [{ file: path, table,
      reason: `deletes from ${table} but never on a failure path — a release only counts inside a catch (directly, or via a helper called from one)` }]
  }

  return pairingViolations(src, path, table, catches, sites)
}

/**
 * Exported so the test below can also run it against a mutated source string.
 *
 * Comments are blanked before anything is measured. Nothing in app/api/webhooks
 * currently depends on that — verified file by file — but every measurement here
 * is of the kind CLAUDE.md names as comment-defeatable: chainOffsets scores a
 * 300-CHARACTER WINDOW after `.from(`, which a comment inside the chain would
 * consume, and RETRYABLE_STATUS is an EXEMPTING match, so a `status: 500`
 * written in prose inside a catch would wave the block through.
 */
export function findViolations(files: Array<{ path: string; src: string }>): DedupViolation[] {
  const violations: DedupViolation[] = []

  for (const { path, src: raw } of files) {
    const src     = blankComments(raw)
    const catches = catchRanges(src)

    for (const table of claimTablesIn(src)) {
      violations.push(...tableViolations(src, path, table, catches))
    }
  }
  return violations
}

function webhookRouteFiles(): Array<{ path: string; src: string }> {
  return collectSourceFiles(['app/api/webhooks'])
    .map((f) => ({ path: rel(f), src: read(f) }))
}

describe('guardrail: webhook dedup claims are released on handler failure', () => {
  it('scans a non-trivial set of webhook routes (guards against a vacuous check)', () => {
    const claiming = webhookRouteFiles().filter((f) => {
      const tables = claimTablesIn(f.src)
      return tables.some((t) => chainOffsets(f.src, t, 'insert').length > 0)
    })
    // stripe, stripe-connect, [provider], telnyx
    expect(claiming.length).toBeGreaterThanOrEqual(4)
  })

  it('every webhook route that claims a dedup row releases it in a catch', () => {
    const violations = findViolations(webhookRouteFiles()).map(
      (v) => `${v.file}: ${v.reason}`,
    )
    expect(violations).toEqual([])
  })

  it('DETECTS the regression it exists for (release removed from a claiming route)', () => {
    const target = webhookRouteFiles().find((f) => f.path.includes('stripe-connect'))
    expect(target, 'stripe-connect webhook route not found').toBeDefined()

    // Reintroduce the exact 2026-07-30 audit finding: the claim insert stays,
    // the catch-block release is deleted.
    const broken = target!.src.replace(
      /\.from\('stripe_processed_events'\)\s*\.delete\(\)/,
      ".from('stripe_processed_events').select()",
    )
    expect(broken, 'fixture did not change — the release pattern moved').not.toBe(target!.src)

    const violations = findViolations([{ path: target!.path, src: broken }])
    expect(violations.length).toBeGreaterThan(0)
  })

  it('DETECTS a release paired with a 2xx (the [provider] route\'s shipped shape)', () => {
    const target = webhookRouteFiles().find((f) => f.path.includes('[provider]'))
    expect(target, 'provider webhook route not found').toBeDefined()

    // Reintroduce the exact defect: the claim release stays, but the catch
    // reports success instead of asking for a redelivery. The provider then
    // never retries, so the release accomplishes nothing and the event is lost.
    const broken = target!.src.replace(
      /return NextResponse\.json\(\{ error: 'Handler failed' \}, \{ status: 500 \}\)/,
      "return NextResponse.json({ received: true }, { status: 200 })",
    )
    expect(broken, 'fixture did not change — the failure return moved').not.toBe(target!.src)

    const violations = findViolations([{ path: target!.path, src: broken }])
    expect(violations.length).toBeGreaterThan(0)
  })
})
