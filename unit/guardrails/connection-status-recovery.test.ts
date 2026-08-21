import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// A CONNECTION IN 'error' MUST STAY REACHABLE BY WHATEVER CAN HEAL IT.
//
// The bug this encodes, found 2026-08-18 with three OwnerRez connections dead
// for three weeks each:
//
//   1. Any sync or refresh failure sets integration_connections.status='error'.
//   2. Every path that could run again filtered .eq('status', 'active').
//   3. Nothing anywhere set it back.
//
// So one transient blip — a 500, a timeout, a rate-limit — removed a tenant
// from every sync path PERMANENTLY, while the PM-facing message said "Sync
// failed — will retry automatically". It never did.
//
// The same deadlock existed independently in all three PMS providers. For
// Hospitable and Hostex it was subtler and worse: store_integration_token DOES
// set status back to 'active', so the recovery existed — but the only two
// callers that would trigger it (the token getter and the refresh cron) both
// filtered to 'active' themselves, so it could never be reached.
//
// ── Why this file asserts only the POSITIVE ──────────────────────────────────
//
// The first version of this guardrail banned `.eq('status','active')` on
// integration_connections outright, with an allowlist. Scoped and
// comment-stripped it still flagged eleven files, and nearly all of them were
// correct as written: a page asking "is Kroger connected?" and a trial email
// asking "which PMS is linked?" have nothing to recover and SHOULD ignore
// errored rows.
//
// Separating those from a recovery path is a judgment call about what the read
// is FOR, which no scan can make — and eleven waved-through exemptions would
// have made the check look like enforcement while asserting nothing. Per
// CLAUDE.md, prose is for judgment and enforcement is for the mechanical, so
// this keeps the mechanical half: the paths known to be recovery paths must
// keep using the widened set. A NEW recovery path added with an active-only
// filter is a review concern, not a lint one.
// ============================================================================

/**
 * Every path that can bring an errored connection back to life.
 *
 * Two kinds, and both must stay widened:
 *   - the sync sweeps themselves, for providers with no refresh (OwnerRez's
 *     tokens never expire; Hostaway's API key cannot be refreshed at all), so
 *     the sweep IS the recovery;
 *   - the token getters and the refresh cron, for providers where a successful
 *     refresh restores 'active' via store_integration_token.
 */
const RECOVERY_PATHS = [
  'lib/inngest/functions/cron/integration-token-refresh.ts',
  'lib/integrations/providers/hospitable-token.ts',
  'lib/integrations/providers/hostex-token.ts',
  'lib/inngest/functions/shared/connection-dispatch.ts',
  'lib/inngest/functions/ownerrez/reconciliation-cron.ts',
  'lib/inngest/functions/ownerrez/incremental-sync.ts',
  'lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts',
]

/**
 * The two spellings of "active only", and why both must be scanned.
 *
 * The first version of this file checked ONLY the query form. It passed —
 * green, in CI, on the very commit that widened the OwnerRez dispatcher —
 * while the same file carried two `conn.status !== 'active'` comparisons on
 * the reloaded row, 680 lines below the widened SELECT.
 *
 * So every errored connection was dispatched by the widened filter, skipped by
 * the narrow one, and recorded as a SUCCESSFUL run. Production wrote no
 * OwnerRez booking between 2026-07-30 and 2026-08-18 while
 * `ownerrez-incremental-sync` logged 358 consecutive successes and the watchdog
 * saw a healthy job. Widening the SELECT is not the fix if the worker it feeds
 * re-narrows it — which is exactly the "half-fixed" shape the second assertion
 * below was written to catch and could not see.
 */
const ACTIVE_ONLY_PATTERNS = [
  // .eq('status', 'active') — the query-filter form.
  /\.eq\(\s*['"]status['"]\s*,\s*['"]active['"]\s*\)/,
  // x.status !== 'active' / === 'active' — the in-code comparison form, on a
  // row already loaded. Use isSyncableConnectionStatus() instead.
  /\.status\s*[!=]==\s*['"]active['"]/,
  // ...and the same comparison written the other way round.
  /['"]active['"]\s*[!=]==\s*\w+\.status\b/,
]

const ACTIVE_ONLY = {
  test: (src: string) => ACTIVE_ONLY_PATTERNS.some((p) => p.test(src)),
}

/**
 * Whole-line comments are blanked before scanning.
 *
 * Not tidiness: these files document the broken spelling they replaced in a
 * comment, and a naive scan reads that prose as a live call site — the same
 * trap that made check-db-invariants fail on the change that fixed IT.
 * Conservative on purpose: a trailing `//` is NOT stripped, because a line
 * containing 'https://' would be truncated and a real finding lost.
 */
function stripCommentLines(src: string): string {
  let inBlock = false
  return src.split('\n').map((line) => {
    const t = line.trim()
    if (inBlock) {
      if (t.includes('*/')) inBlock = false
      return ''
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true
      return ''
    }
    return (t.startsWith('//') || t.startsWith('*')) ? '' : line
  }).join('\n')
}

function sourceFor(path: string): string | null {
  const file = collectSourceFiles(['app', 'lib']).find((f) => rel(f) === path)
  return file ? read(file) : null
}

describe('guardrail: an errored connection stays reachable by what can heal it', () => {
  it('every recovery path selects on SYNCABLE_CONNECTION_STATUSES', () => {
    const missing = RECOVERY_PATHS.filter((path) => {
      const src = sourceFor(path)
      return src === null || !src.includes('SYNCABLE_CONNECTION_STATUSES')
    })

    expect(missing, [
      'A recovery path stopped selecting on SYNCABLE_CONNECTION_STATUSES.',
      '',
      "A failed sync or refresh sets status='error'. If the path that would run",
      'again also excludes it, the connection is dead until a human reconnects —',
      'the 2026-08-18 bug, which cost three OwnerRez connections three weeks each',
      'while the UI promised automatic recovery.',
      '',
      "SYNCABLE_CONNECTION_STATUSES is 'active' + 'error'. It still excludes",
      "'revoked', which is the one status that genuinely does need a human.",
      '',
      'If a file here is no longer a recovery path, remove it from RECOVERY_PATHS',
      'in this test and say why in the same change.',
    ].join('\n')).toEqual([])
  })

  it('no recovery path ALSO narrows back to active-only, in either spelling', () => {
    // Belt to the braces above: referencing the constant somewhere in the file
    // is not the same as every connection check in it using the constant. A
    // file that imports it and still narrows on a second query — or on a row it
    // re-loaded — is half-fixed, which is both the shape a partial revert takes
    // and the shape that shipped on 2026-08-18.
    const halfFixed = RECOVERY_PATHS.filter((path) => {
      const src = sourceFor(path)
      return src !== null && ACTIVE_ONLY.test(stripCommentLines(src))
    })

    expect(halfFixed, [
      'A recovery path narrows back to active-only.',
      '',
      'A widened SELECT is not the fix if the worker it dispatches to re-checks',
      "`conn.status !== 'active'` on the row it reloaded: the connection is",
      'fanned out, skipped, and the run reports SUCCESS — invisible to the ledger,',
      'the watchdog and Sentry alike.',
      '',
      'Use isSyncableConnectionStatus(status) for a status already in hand, and',
      ".in('status', [...SYNCABLE_CONNECTION_STATUSES]) for a query filter.",
    ].join('\n')).toEqual([])
  })

  it('no inbound webhook route rejects a connection for being in error', () => {
    // RECOVERY_PATHS above is a list, and a list only covers what someone
    // thought to put in it. It named outbound paths — crons, token getters,
    // sweeps — because those were the recovery paths when it was written. The
    // INBOUND direction was not on it, and on 2026-08-21 the Hostex webhook
    // route was found carrying `status !== 'active'`: the last instance of this
    // spelling anywhere in the tree.
    //
    // Stated as a list this would go stale again on the next provider, so it is
    // stated as a property of a place instead. A webhook route is the one file
    // shape where the judgment is not a judgment: it renders nothing and counts
    // nothing, so a status gate in it can only mean "process this delivery or
    // throw it away". 'error' describes our last OUTBOUND sync and says nothing
    // about whether the provider's push is genuine.
    //
    // Hostex is the worst case and the reason for the bound: 3 seconds to
    // acknowledge and NO redelivery, so a refusal is permanent — during exactly
    // the window a failing sync had put the connection in 'error'. Meanwhile
    // the daily reconcile kept running and the integration kept looking fine.
    const offenders = collectSourceFiles(['app'])
      .filter((f) => rel(f).startsWith('app/api/webhooks/'))
      .filter((f) => {
        const src = read(f)
        return src.includes("'integration_connections'") && ACTIVE_ONLY.test(stripCommentLines(src))
      })
      .map(rel)

    expect(offenders, [
      'A webhook route rejects deliveries for a connection in error state.',
      '',
      "status='error' means our last SYNC failed — an expired token, a 5xx, a",
      'throttle. It is not a statement about whether an inbound delivery is',
      'genuine, and it is set precisely when things are going wrong, i.e. when',
      'the pushes being refused matter most.',
      '',
      'Use isSyncableConnectionStatus(connection.status). It still excludes',
      "'revoked' and 'disconnected', which is the rejection you actually want.",
    ].join('\n')).toEqual([])
  })

  it('SELF-CHECK: the scan fires on both spellings, and not on the fix', () => {
    // A guardrail at zero because it is BLIND looks exactly like one at zero
    // because the tree is clean — and this file spent a commit in the first
    // state. These fixtures are the difference.
    expect(ACTIVE_ONLY.test(".eq('status', 'active')")).toBe(true)
    expect(ACTIVE_ONLY.test("if (conn.status !== 'active') return")).toBe(true)
    expect(ACTIVE_ONLY.test("if (row.status === 'active') sync()")).toBe(true)
    expect(ACTIVE_ONLY.test("if ('active' !== conn.status) return")).toBe(true)

    // CONTROLS — the correct spellings must NOT trip it, or the guardrail
    // becomes a reason to work around itself.
    expect(ACTIVE_ONLY.test(".in('status', [...SYNCABLE_CONNECTION_STATUSES])")).toBe(false)
    expect(ACTIVE_ONLY.test('if (!isSyncableConnectionStatus(conn.status)) return')).toBe(false)
    // A DIFFERENT column that happens to hold 'active' is not this bug.
    expect(ACTIVE_ONLY.test(".eq('plan_status', 'active')")).toBe(false)
    expect(ACTIVE_ONLY.test("org.plan_status === 'active'")).toBe(false)
  })

  it('SYNCABLE_CONNECTION_STATUSES includes error and excludes revoked', () => {
    // The constant is the whole fix; a well-meaning "tighten this up" edit that
    // drops 'error' silently reinstates the deadlock across all three
    // providers, and every other assertion here would still pass.
    const src = sourceFor('lib/integrations/connection-metadata.ts')
    expect(src).not.toBeNull()

    const decl = /SYNCABLE_CONNECTION_STATUSES\s*=\s*\[([^\]]*)\]/.exec(src!)
    expect(decl, 'SYNCABLE_CONNECTION_STATUSES declaration not found').not.toBeNull()

    const members = decl![1]!
    expect(members).toContain("'active'")
    expect(members).toContain("'error'")
    expect(members).not.toContain("'revoked'")
  })
})
