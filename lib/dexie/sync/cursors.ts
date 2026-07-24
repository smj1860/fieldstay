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

import { getDexieDb } from '../schema'

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
