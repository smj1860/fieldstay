// lib/dexie/sync/scope.ts
//
// Scope-change gating for the two cached tables that neither need low latency
// nor mutate in a way the crew can see.
//
// property_assets and inventory_items were pulled in full on every safety-poll
// tick — a one-to-many fan-out across every assigned property, paginated,
// uncursored, every five minutes, forever. What the crew actually reads from
// them barely changes:
//
//   - property_assets is monotonic. An asset is captured once and then it's
//     captured; a stale cache means at worst a crew member re-captures a type
//     a coworker just did, which the unique index already rejects with a
//     clear message.
//   - inventory_items, since the count input stopped being pre-filled from
//     current_quantity, is name/unit/category/par_level — all PM-edited and
//     all rare. current_quantity still churns server-side, but nothing on the
//     device renders it any more, so a cursor would just return rows whose
//     crew-relevant fields hadn't changed.
//
// So both are pulled when the assigned-property set CHANGES (which is when a
// device needs them warm for offline use — the assignment arrives before the
// crew member drives out of signal) and when the screen that reads them is
// opened, rather than on a timer.
//
// The comparison is a local Dexie read, so an unchanged scope costs zero
// network requests rather than a cheap one.

import { getDexieDb } from '../schema'

export type ScopeKey = 'scope:property_assets' | 'scope:inventory_items'

function serialize(ids: readonly string[]): string {
  return [...ids].sort((a, b) => a.localeCompare(b)).join(',')
}

/**
 * True when `ids` differs from the set this key was last pulled for.
 *
 * Deliberately does NOT record the new value — the caller records it only
 * after the pull actually succeeds, so a failed fetch is retried on the next
 * pass instead of being remembered as done.
 */
export async function scopeChanged(
  userId: string,
  key: ScopeKey,
  ids: readonly string[],
): Promise<boolean> {
  const db = getDexieDb(userId)
  const previous = (await db.sync_meta.get(key))?.value
  return previous !== serialize(ids)
}

/** Records the scope a pull just succeeded for. */
export async function rememberScope(
  userId: string,
  key: ScopeKey,
  ids: readonly string[],
): Promise<void> {
  const db = getDexieDb(userId)
  await db.sync_meta.put({ key, value: serialize(ids) })
}

/**
 * Forgets a recorded scope, so the next pass re-pulls regardless.
 *
 * The escape hatch for the screens that read these tables: opening the crew
 * Assets page or a turnover's inventory tab is the one moment freshness is
 * worth a round trip, and it is also when a co-crew member's capture is most
 * likely to have happened since the last pull.
 */
export async function invalidateScope(userId: string, key: ScopeKey): Promise<void> {
  const db = getDexieDb(userId)
  await db.sync_meta.delete(key)
}
