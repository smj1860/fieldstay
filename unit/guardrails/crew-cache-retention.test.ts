import { describe, it, expect } from 'vitest'
import { readCode } from './scan'

// ============================================================================
// The crew device cache has a retention horizon now, and two properties of it
// are invisible from any single call site — which is what this guardrail is
// for. Both were paid for before the code was written: one by a simulation
// against the real sync path, one by reading the photo-upload path.
//
// 1. THE PURGE PREDICATE IS THE CURSOR, NOT "IS IT COMPLETED".
//    advanceCursor stores max(updated_at) - CURSOR_OVERLAP_MS, so a turnover
//    completed moments ago sits inside that overlap and its items return on the
//    very next delta pull. A completion-triggered purge therefore loops:
//    purge, re-pull, purge again, on the most recent job — the one a crew
//    member is most likely to reopen. Measured in
//    unit/dexie/crew-cache-retention-behaviour.test.ts before the fix existed.
//
// 2. THE RETAIN GUARD READS BOTH OUTBOXES.
//    photo-sync resolves a queued photo's storage org prefix by walking the
//    LOCAL cache (checklist_instance_items -> checklist_instances -> org_id).
//    Shed an item row with a photo still queued and that walk returns null,
//    which is a bounded backed-off failure and then a dead letter: a crew
//    member's photograph destroyed by a cache cleanup. `mutations` alone is not
//    enough — photos live in their own queue.
//
// Scanned with readCode() rather than read(): a raw-source scan reads the
// comments too, and this file's own prose names every symbol it asserts on, so
// a comment-blind check is the only one that means anything here.
// ============================================================================

const prune = readCode('lib/dexie/prune.ts')

/**
 * The body of one top-level function in prune.ts.
 *
 * Every assertion below is scoped through this rather than run against the
 * whole file, and that is not tidiness. `db.pending_photo_uploads.toArray()`
 * appears FIVE times in this module (the orphan-blob sweep and
 * countPendingSyncWork among them), so a file-wide `toContain` for it passes
 * whether or not the retain guard reads that queue at all — which is exactly
 * what a fire-check of this guardrail showed on its first run: the photo queue
 * was removed from the guard and the check stayed green.
 */
function fnBody(name: string): string {
  const start = prune.indexOf(`function ${name}`)
  if (start === -1) return ''
  const rest = prune.slice(start)
  const next = rest.indexOf('\nfunction ', 1)
  const nextExport = rest.indexOf('\nexport ', 1)
  const ends = [next, nextExport].filter((n) => n > 0)
  return ends.length ? rest.slice(0, Math.min(...ends)) : rest
}

describe('crew cache retention', () => {
  it('purges against the delta cursor, never on completion alone', () => {
    const fn = fnBody('pruneSettledChecklistItems')
    expect(fn).toContain("getCursor(userId, 'cursor:checklist_items')")
    // The comparison itself: an instance is shed only when it settled BEFORE
    // the cursor. Without this the purge is completion-triggered and thrashes.
    expect(fn).toMatch(/completed_at\s*<\s*cursor/)
  })

  it('does nothing when there is no cursor yet', () => {
    // No cursor means the next pull is a FULL pull of the whole scope, so
    // anything shed now returns immediately — a guaranteed thrash.
    expect(fnBody('pruneSettledChecklistItems')).toMatch(/if\s*\(cursor === null\)\s*return 0/)
  })

  it('never sheds a checklist with unsent work in EITHER outbox', () => {
    const guard = fnBody('idsWithPendingWork')
    expect(guard).not.toBe('')
    expect(guard).toContain('db.mutations.toArray()')
    expect(guard).toContain('db.pending_photo_uploads.toArray()')
    // ...and the purge actually consults it.
    expect(fnBody('pruneSettledChecklistItems')).toContain('idsWithPendingWork(db)')
  })

  it('does not filter the retain guard to pending rows only', () => {
    // A transport failure never sets `failed`, so a stalled mutation looks
    // identical to a healthy one from the flag alone. Filtering here would
    // retain the cache for the writes that are fine and shed it for the ones
    // that are not — exactly backwards.
    const guard = fnBody('idsWithPendingWork')
    expect(guard).not.toBe('')
    expect(guard).not.toMatch(/\.failed/)
    expect(guard).not.toMatch(/where\(/)
  })

  it('runs on every resync, not only on the repair path', () => {
    // pruneLocalCache is called from fullCrewResync, which is the ordinary
    // mount/reconnect/safety-poll path AND the tail of forceFullCrewResync.
    // Wiring the purge anywhere else would leave a forced resync's re-inflated
    // cache as the device's new resting size.
    expect(fnBody('pruneLocalCache')).toContain('pruneSettledChecklistItems(userId)')

    const resync = readCode('lib/dexie/sync/full-resync.ts')
    expect(resync).toContain('pruneLocalCache(userId)')
  })

  it('keeps the turnover and instance rows it depends on', () => {
    // Shedding the TURNOVER re-pulls everything: partitionByKnown reclassifies
    // an id the device no longer holds as `fresh`, and fresh ids skip the
    // cursor. Shedding the INSTANCE loses completed_at, which is the only local
    // record of when the checklist settled (item rows drop updated_at).
    const fn = fnBody('pruneSettledChecklistItems')
    expect(fn).not.toBe('')
    expect(fn).toContain('db.checklist_instance_items.bulkDelete')
    expect(fn).not.toContain('db.turnovers.bulkDelete')
    expect(fn).not.toContain('db.checklist_instances.bulkDelete')
  })
})
