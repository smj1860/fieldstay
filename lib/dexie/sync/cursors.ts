// lib/dexie/sync/cursors.ts
//
// Per-entity delta-sync cursors for the crew PWA, stored in Dexie's
// sync_meta table. A cursor is the ISO timestamp of the newest row a pull
// has SEEN for that entity, minus a small overlap window — pulls filter
// `.gt('updated_at', cursor)` so each sync only transfers what changed.
//
// Rules that keep this correct:
//  - Cursors are derived from row updated_at values, never from client
//    wall-clock (clock skew) and never from server "now" (a row committed
//    mid-pull with an earlier timestamp would be skipped forever).
//  - CURSOR_OVERLAP_MS is subtracted so rows that commit with timestamps
//    slightly out of order are re-fetched next pull. Every consumer writes
//    via idempotent bulkPut, so re-fetching a few rows is free.
//  - A cursor only ever moves FORWARD, and only when a pull actually
//    returned rows — an empty delta is a no-op, not an advance.
//  - Cursors are a payload optimization only. Row DELETION and scope
//    membership are handled by the callers' reconciliation logic (full
//    id-set pulls), so a conservative or missing cursor can only cost
//    bandwidth, never correctness.

import { getDexieDb, type MutationTable } from '../schema'

export const CURSOR_OVERLAP_MS = 10_000

/**
 * Every delta cursor, as a value — the type is DERIVED from it rather than
 * declared alongside it, so the union and the list cannot disagree.
 *
 * resetAllCursors() reads this rather than CURSORS_BY_MUTATION_TABLE below,
 * and the difference is load-bearing: that map answers "which cursors guard
 * the table this ABANDONED MUTATION targets", which is a strictly smaller
 * question. A cursor gating a cache the crew only ever READS has no mutation
 * table pointing at it, so deriving the full-reset list from that map would
 * quietly leave exactly such a cursor un-reset — in the one function whose
 * entire purpose is repairing a device whose cache has diverged.
 */
export const SYNC_CURSOR_KEYS = [
  'cursor:turnovers',
  'cursor:checklist_instances',
  'cursor:checklist_items',
  'cursor:work_orders',
] as const

export type SyncCursorKey = typeof SYNC_CURSOR_KEYS[number]

/**
 * Pure cursor-advance rule, extracted for direct unit testing:
 * max(updated_at of rows seen) − overlap, and never backward.
 * Returns null when there is nothing to advance to.
 */
export function computeAdvancedCursor(
  current: string | null,
  seenUpdatedAts: readonly (string | null | undefined)[],
  overlapMs: number = CURSOR_OVERLAP_MS,
): string | null {
  let maxSeen: number | null = null
  for (const ts of seenUpdatedAts) {
    if (!ts) continue
    const ms = Date.parse(ts)
    if (Number.isNaN(ms)) continue
    if (maxSeen === null || ms > maxSeen) maxSeen = ms
  }
  if (maxSeen === null) return current

  const candidate = new Date(maxSeen - overlapMs).toISOString()
  if (current !== null && candidate <= current) return current
  return candidate
}

/**
 * Splits a freshly-fetched scope id set into ids the local cache already
 * knows vs. ids that are new to it. New ids must be pulled WITHOUT a
 * cursor: their rows may not have been touched in ages, so a delta filter
 * would skip them entirely (the classic scope-growth vs. cursor trap).
 */
export function partitionByKnown(
  scopeIds: readonly string[],
  knownIds: ReadonlySet<string>,
): { known: string[]; fresh: string[] } {
  const known: string[] = []
  const fresh: string[] = []
  for (const id of scopeIds) {
    if (knownIds.has(id)) known.push(id)
    else fresh.push(id)
  }
  return { known, fresh }
}

/**
 * Which cursors gate the pull that would re-fetch a given mutation's table.
 *
 * TOTAL, not Partial — every member of MutationTable must appear, and a table
 * that genuinely needs no rewind says so with an explicit empty array and a
 * reason. As a Partial this compiled fine with a table simply missing, and the
 * consequence of an accidental omission is the exact failure this module exists
 * to prevent (see invalidateCursorsFor below): the local cache pinned to a
 * value the server never accepted, permanently, with no user-visible symptom
 * and nothing in any log. That is far too quiet to leave to whether the next
 * person remembers this map exists. Now it is a compile error.
 *
 * The four empty entries are empty for two different reasons, and the
 * distinction matters if one of them ever changes:
 *
 *  • NOT CACHED AT ALL. work_order_reports, inventory_counts and messages are
 *    outbox-only — the crew SUBMITS them and never reads them back from Dexie
 *    (see CREW_SYNCED_TABLES in ../schema.ts). There is no cached row to pin,
 *    so there is nothing to rewind.
 *  • CACHED BUT UNCURSORED. property_assets IS in the Dexie cache, but it is
 *    pulled as a full set whenever the assigned-property scope changes
 *    (./scope.ts) rather than by an `.gt('updated_at', …)` delta. A full pull
 *    re-fetches the server row unconditionally, so abandoning a mutation
 *    already self-heals. Give property_assets a cursor and this entry stops
 *    being correct.
 */
const CURSORS_BY_MUTATION_TABLE: Readonly<Record<MutationTable, readonly SyncCursorKey[]>> = {
  turnovers:                ['cursor:turnovers'],
  checklist_instances:      ['cursor:checklist_instances'],
  checklist_instance_items: ['cursor:checklist_items'],
  crew_work_orders:         ['cursor:work_orders'],

  // Not cached — outbox-only submissions, nothing to re-fetch.
  work_order_reports:       [],
  inventory_counts:         [],
  messages:                 [],

  // Cached, but pulled as a full scope set rather than a delta — see above.
  property_assets:          [],
}

/**
 * Rewinds the cursors guarding a table so the next pull re-fetches the
 * server's authoritative row for it.
 *
 * Required whenever a pending mutation is ABANDONED. While it was queued,
 * shadowPendingMutations() replayed it over every pulled row — and
 * advanceCursor() moved past that row's updated_at at the same time. Drop the
 * mutation and the overlay disappears, but the cursor does not come back: the
 * delta filter `.gt('updated_at', cursor)` will never return that row again,
 * and partitionByKnown() routes it down the delta path because the device
 * already knows the id. The local cache is then pinned to a value the server
 * never accepted, permanently and invisibly.
 *
 * That happens on an explicit discard AND with no user action at all, when
 * pruneExpiredDeadLetters() collects a dead letter at 30 days.
 */
export async function invalidateCursorsFor(userId: string, table: MutationTable): Promise<void> {
  const keys = CURSORS_BY_MUTATION_TABLE[table]
  if (!keys.length) return
  const db = getDexieDb(userId)
  await Promise.all(keys.map((key) => db.sync_meta.delete(key)))
}

/**
 * Rewinds EVERY cursor, so the next resync transfers full rows rather than a
 * delta. The repair path for a device whose cache has diverged from the server
 * — previously there was none: `force` was plumbed through every sync function
 * but never passed as `true` from anywhere, and cursors were never reset, so
 * the only way out was logout, which destroys the outbox along with the cache.
 */
export async function resetAllCursors(userId: string): Promise<void> {
  const db = getDexieDb(userId)
  await Promise.all(SYNC_CURSOR_KEYS.map((key) => db.sync_meta.delete(key)))
}


export async function getCursor(userId: string, key: SyncCursorKey): Promise<string | null> {
  const row = await getDexieDb(userId).sync_meta.get(key)
  return row?.value ?? null
}

/**
 * Advances the cursor from the updated_at values of rows a pull just
 * landed. No-op when the rows carry nothing newer than the current cursor.
 */
export async function advanceCursor(
  userId: string,
  key: SyncCursorKey,
  seenRows: readonly { updated_at?: string | null }[],
): Promise<void> {
  const db = getDexieDb(userId)
  const current = (await db.sync_meta.get(key))?.value ?? null
  const next = computeAdvancedCursor(current, seenRows.map((r) => r.updated_at))
  if (next !== null && next !== current) {
    await db.sync_meta.put({ key, value: next })
  }
}

// ── Sync health ─────────────────────────────────────────────────────────────
//
// The crew home screen renders "You're all caught up — no active assignments."
// whenever the local cache is empty. That sentence is true for a cleaner with
// nothing booked and equally true for a device whose sync has never once
// succeeded, and the two are indistinguishable on screen — the exact collapse
// of "zero rows" into "the query errored" that CLAUDE.md's silent-failure rule
// exists to prevent.
//
// It cost a real diagnosis: a crew member assigned to a turnover six days out
// saw an empty Upcoming, and nothing anywhere — screen, log, or cache — could
// say whether the assignment was missing or the sync had simply never run.
//
// Stored in sync_meta rather than React state so it survives a reload and is
// readable straight out of IndexedDB when someone is looking at a real device.

const LAST_SYNC_OK_KEY    = 'sync:last_ok_at'
const LAST_SYNC_ERROR_KEY = 'sync:last_error'

export interface CrewSyncHealth {
  /** ISO timestamp of the last fully successful resync, null if never. */
  lastOkAt:    string | null
  /** Message from the most recent failed resync, null if none since. */
  lastError:   string | null
  /** False until a resync has completed end to end at least once. */
  everSynced:  boolean
}

export async function recordSyncSuccess(userId: string): Promise<void> {
  const db = getDexieDb(userId)
  await db.sync_meta.put({ key: LAST_SYNC_OK_KEY, value: new Date().toISOString() })
  await db.sync_meta.delete(LAST_SYNC_ERROR_KEY)
}

export async function recordSyncFailure(userId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  await getDexieDb(userId).sync_meta.put({
    key:   LAST_SYNC_ERROR_KEY,
    // Bounded: this is surfaced in the UI and stored on the device.
    value: message.slice(0, 300),
  })
}

export async function readSyncHealth(userId: string): Promise<CrewSyncHealth> {
  const db = getDexieDb(userId)
  const [ok, error] = await Promise.all([
    db.sync_meta.get(LAST_SYNC_OK_KEY),
    db.sync_meta.get(LAST_SYNC_ERROR_KEY),
  ])
  return {
    lastOkAt:   ok?.value ?? null,
    lastError:  error?.value ?? null,
    everSynced: Boolean(ok?.value),
  }
}
