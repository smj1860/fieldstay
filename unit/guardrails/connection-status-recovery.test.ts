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

const ACTIVE_ONLY = /\.eq\(\s*['"]status['"]\s*,\s*['"]active['"]\s*\)/

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

  it('no recovery path ALSO carries a bare active-only filter', () => {
    // Belt to the braces above: referencing the constant somewhere in the file
    // is not the same as every connection read in it using the constant. A file
    // that imports it and still has an `.eq('status','active')` on a second
    // query is half-fixed, which is the shape a partial revert would take.
    const halfFixed = RECOVERY_PATHS.filter((path) => {
      const src = sourceFor(path)
      return src !== null && ACTIVE_ONLY.test(stripCommentLines(src))
    })

    expect(halfFixed, 'recovery paths still containing a bare active-only filter').toEqual([])
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
