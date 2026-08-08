import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Idempotency guardrail: an Inngest step can retry (network blip, function
// timeout, a redeploy mid-run) and re-execute its body — a step.run(...) that
// unconditionally .insert()s with no dedup guard creates a duplicate row on
// every such retry, silently. CLAUDE.md's Inngest Functions section states
// the rule ("Any step that creates a database record must check
// source_reference_id first... or use ON CONFLICT DO NOTHING") but nothing
// enforced it until now.
//
// Scope: lib/inngest/functions/** only. A Server Action or Route Handler
// isn't automatically retried by the platform the way an Inngest step is —
// the idempotency need this guardrail polices is specific to Inngest's
// at-least-once step-retry semantics.
//
// A `.from('table').insert(...)` counts as protected if, within the SAME
// enclosing step.run(...) body:
//   - an earlier `.from('table').select(...)` pre-checks the natural key
//     before inserting (see flagged-turnover-wo.ts, cron/work-order-ops.ts's
//     schedule-based WO creation), or
//   - an earlier `.from('table').delete(...)` clears the table first
//     (delete-then-recreate — see checklist-broadcast.ts), or
//   - `onConflict`/`ignoreDuplicates`/a `23505` catch/a `dedup(e)?_key`
//     appears anywhere in the same step body (upsert-with-conflict-target,
//     or catch-the-unique-violation, or a dedupe_key/dedup_key column write
//     backed by a partial unique index — see log-message-comm.ts,
//     work-order-dispatch.ts, auto-assign-turnover.ts), or
//   - the insert goes through createPmNotification(), which already
//     encapsulates the notifications.dedupe_key dedup itself.
//
// Everything else is named in EXCEPTIONS with a reason — some are genuinely
// permanent architectural facts (a child insert transitively protected by
// its parent's own pre-check), and two are real, still-open gaps found
// during the same audit that built this guardrail (see the entries below) —
// left open rather than fixed blind, because closing them requires a
// product decision about what "duplicate" means for a free-form note log,
// not a mechanical copy of the pre-check pattern used elsewhere.
// ============================================================================

const INSERT_CALL = /\.from\(\s*['"]([a-z_]+)['"]\s*\)([\s\S]{0,80}?)\.insert\(/g
const NEARBY_PROTECTION = /onConflict|ignoreDuplicates|23505|dedup(e)?_key|createPmNotification/

function enclosingStepRunBody(src: string, atIdx: number): { body: string; bodyStart: number } | null {
  let searchFrom = atIdx
  for (;;) {
    const stepIdx = src.lastIndexOf('step.run(', searchFrom)
    if (stepIdx === -1) return null
    const openParen = src.indexOf('(', stepIdx)
    let depth = 1
    let i = openParen + 1
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
    }
    const bodyEnd = i
    if (atIdx >= openParen && atIdx < bodyEnd) return { body: src.slice(openParen, bodyEnd), bodyStart: openParen }
    searchFrom = stepIdx - 1
    if (searchFrom < 0) return null
  }
}

interface InsertSite {
  key:       string  // 'path:line'
  protected: boolean
}

// The full population of `.from('table').insert(...)` calls found inside a
// step.run(...) body, each marked protected/unprotected. Kept as one pass so
// the sanity check (population isn't silently empty) and the actual
// assertion (every unprotected one is a named exception) look at the same
// underlying scan.
function scanInsertSites(): InsertSite[] {
  const sites: InsertSite[] = []
  for (const file of collectSourceFiles(['lib/inngest/functions'])) {
    const src = read(file)
    INSERT_CALL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = INSERT_CALL.exec(src))) {
      const table = m[1]
      const insertIdx = m.index
      const enclosing = enclosingStepRunBody(src, insertIdx)
      if (!enclosing) continue // not inside a step.run at all — not this guardrail's concern

      const { body: stepBody, bodyStart } = enclosing
      const insertOffsetInBody = insertIdx - bodyStart
      const before = stepBody.slice(0, insertOffsetInBody)
      const after  = stepBody.slice(insertOffsetInBody)

      const selectRe = new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)[\\s\\S]{0,60}?\\.select\\(`)
      const deleteRe = new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)[\\s\\S]{0,60}?\\.delete\\(`)

      const protectedBefore = selectRe.test(before) || deleteRe.test(before) || NEARBY_PROTECTION.test(before)
      const protectedAfter  = NEARBY_PROTECTION.test(after)

      const line = src.slice(0, insertIdx).split('\n').length
      sites.push({ key: `${rel(file)}:${line}`, protected: protectedBefore || protectedAfter })
    }
  }
  return sites
}

// Verified against the codebase 2026-07-26.
const EXCEPTIONS: Record<string, string> = {
  // (removed) lib/inngest/functions/inventory-events.ts — the
  // purchase_order_items insert moved into the insertPoItems() helper so the
  // create path and the zero-items repair path share one implementation. This
  // scan only inspects `.insert(` INSIDE a step.run body, so it no longer sees
  // that call at all — a blind spot, not a fix, and worth knowing about when
  // reading this list. Behavioural coverage replaced it:
  // unit/inngest/inventory-events-po.test.ts asserts the pre-check
  // short-circuits only on a PO that actually has line items, that a header
  // with zero items is repaired rather than declared done, and that both
  // writes throw instead of being discarded.
  'lib/inngest/functions/cron/work-order-ops.ts:323':
    'FIXED, kept as an exception because the guard is cross-table and this scan only recognizes same-table guards: the work_order_updates note batch is written only for the rows the preceding optimistic-locked bulk UPDATE actually changed (`.update({priority:\'urgent\'}).in(\'id\', ids).neq(\'priority\', \'urgent\').select(\'id\')`). A step retry matches zero rows there (they are already urgent), so zero notes are inserted. Its twin in cron/maintenance-schedules.ts now uses the same guard (it was the last open entry in this list and was closed 2026-08-08 by copying this pattern rather than re-litigating what makes two escalation events \'the same\').',
}

describe('guardrail: Inngest step.run() inserts are idempotent on retry', () => {
  const sites = scanInsertSites()
  const offenders = sites.filter((s) => !s.protected).map((s) => s.key)

  it('finds the step.run+insert population (sanity: the scan is not silently empty)', () => {
    expect(sites.length).toBeGreaterThan(10)
  })

  it('every step.run() insert is either protected or a named, justified exception', () => {
    const unlisted = offenders.filter((o) => !EXCEPTIONS[o])

    expect(
      unlisted,
      [
        'A step.run(...) body inserts a row with no dedup guard — Inngest',
        'retries a failed step, so this can create a duplicate row on retry',
        '(CLAUDE.md: "Any step that creates a database record must check',
        'source_reference_id first... or use ON CONFLICT DO NOTHING").',
        'Add a pre-check select, an onConflict/ignoreDuplicates upsert, a',
        '23505 catch, or a dedupe_key/dedup_key column — or, if genuinely',
        'protected some other way, add it to EXCEPTIONS in this test with a',
        'reason. Offenders:',
        ...unlisted,
      ].join('\n')
    ).toEqual([])
  })

  it('every EXCEPTIONS entry still exists at that file:line (prune when code moves)', () => {
    const present = new Set(offenders)
    for (const key of Object.keys(EXCEPTIONS)) {
      expect(
        present.has(key),
        `EXCEPTIONS lists ${key}, which no longer matches the unprotected-insert pattern — remove the stale entry (the code likely moved or was fixed).`
      ).toBe(true)
    }
  })
})
