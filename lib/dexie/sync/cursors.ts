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

export type SyncCursorKey =
  | 'cursor:turnovers'
  | 'cursor:checklist_instances'
  | 'cursor:checklist_items'
  | 'cursor:work_orders'

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
 * Tables pulled in full every time (inventory_items, properties,
 * property_assets) have no cursor and so need no rewind.
 */
const CURSORS_BY_MUTATION_TABLE: Readonly<Partial<Record<MutationTable, readonly SyncCursorKey[]>>> = {
  turnovers:                ['cursor:turnovers'],
  checklist_instances:      ['cursor:checklist_instances'],
  checklist_instance_items: ['cursor:checklist_items'],
  crew_work_orders:         ['cursor:work_orders'],
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
  if (!keys?.length) return
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
  await Promise.all(ALL_CURSOR_KEYS.map((key) => db.sync_meta.delete(key)))
}

const ALL_CURSOR_KEYS: readonly SyncCursorKey[] = [
  'cursor:turnovers',
  'cursor:checklist_instances',
  'cursor:checklist_items',
  'cursor:work_orders',
]

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
