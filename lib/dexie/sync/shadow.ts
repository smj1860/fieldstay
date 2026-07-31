// lib/dexie/sync/shadow.ts
//
// Pending-mutation shadowing.
//
// Every pull in lib/dexie/sync/* ends in an unconditional `bulkPut` of the
// server's version of a row. That is correct for rows the device hasn't
// touched — and wrong for a row with a queued-but-unpushed local write:
// the delta pull, safety poll, reconnect resync, or a co-crew member's
// broadcast would revert the crew member's own work in front of them,
// even though the outbox still holds it and will push it moments later.
//
// The fix is to rebase: after fetching the server rows, replay the fields
// carried by every still-pending outbox mutation for those rows on top,
// in insertion order (so the newest queued value wins, exactly as it will
// server-side once the outbox drains).
//
// Only fields the fetched row actually has are replayed — a mutation
// payload can carry transport-only keys (`scanRequest`, `report_id`,
// `notes` routed to a Route Handler) that are not columns of the cached
// row and must not be injected into the Dexie cache.
//
// Dead-lettered (`failed`) mutations are included deliberately: that write
// has NOT reached the server either, so the local value is still the
// crew's most recent truth and the failed-sync surface is what tells them
// it hasn't landed.

import { getDexieDb, type MutationTable } from '../schema'

type Row = Record<string, unknown>

/**
 * Returns `rows` with every pending outbox mutation for `mutationTable`
 * replayed over the matching row, keyed by `idField` (the Dexie primary
 * key, which is what `MutationRow.targetId` holds).
 */
export async function shadowPendingMutations<T extends object>(
  userId: string,
  mutationTable: MutationTable,
  rows: T[],
  idField = 'id',
): Promise<T[]> {
  if (!rows.length) return rows

  const db = getDexieDb(userId)
  const targetIds = new Set(rows.map((r) => (r as Row)[idField] as string))

  // Insertion order (`orderBy('id')`) is what makes "last queued value
  // wins" hold — the same order processOutbox() pushes them in.
  const pending = (await db.mutations.orderBy('id').toArray())
    .filter((m) => m.table === mutationTable && targetIds.has(m.targetId))
  if (!pending.length) return rows

  const overlays = new Map<string, Row>()
  for (const mutation of pending) {
    const existing = overlays.get(mutation.targetId) ?? {}
    overlays.set(mutation.targetId, { ...existing, ...mutation.payload })
  }

  return rows.map((row) => {
    const overlay = overlays.get((row as Row)[idField] as string)
    if (!overlay) return row

    const rebased: Row = { ...(row as Row) }
    for (const [key, value] of Object.entries(overlay)) {
      // Never introduce a key the cached row shape doesn't have.
      if (key in rebased) rebased[key] = value
    }
    return rebased as T
  })
}

/**
 * `table.bulkPut(rows)` with pending local writes rebased on top. Every
 * pull site that writes a Supabase-backed row into Dexie should use this
 * instead of a bare `bulkPut`.
 */
export async function bulkPutShadowed<T extends object>(
  table: { bulkPut: (rows: T[]) => Promise<unknown> },
  userId: string,
  mutationTable: MutationTable,
  rows: T[],
  idField = 'id',
): Promise<void> {
  const rebased = await shadowPendingMutations(userId, mutationTable, rows, idField)
  await table.bulkPut(rebased)
}
