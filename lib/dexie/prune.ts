// lib/dexie/prune.ts
//
// Local cache garbage collection for the crew PWA.
//
// Only three of the cached tables reconcile deletions during a pull
// (turnovers + its checklists via the assignment scope, and crew_work_orders
// via its id-set snapshot). Everything else is bulkPut-only and therefore
// grows without bound on a device that stays logged in for months —
// `messages` worst of all (500 rows per pull against a rolling 90-day
// server window, nothing ever removed locally).
//
// Dead-lettered outbox rows and exhausted photo-queue rows are deliberately
// NOT collected on sight: they are the durable trace that a write never
// reached the server, and the crew shell's failed-sync surface is built on
// them. They're collected only once they're older than
// DEAD_LETTER_RETENTION_DAYS, by which point the crew member has had every
// opportunity to retry or discard them.

import { getDexieDb, type FieldStayDexie } from './schema'
import { deletePendingPhotoBlob, listPendingPhotoBlobKeys } from './photo-queue'
import { invalidateCursorsFor } from './sync/cursors'

/**
 * How long a dead-lettered mutation / failed photo stays on the device
 * before it's collected. Long enough that a crew member who only opens the
 * app on shift days still sees it in the failed-sync surface.
 */
export const DEAD_LETTER_RETENTION_DAYS = 30

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

/**
 * Removes cached rows the crew member can no longer reach, plus expired
 * dead letters. Safe to call on every resync — every deletion is derived
 * from the current local scope, never from a server response, so it is
 * correct offline too.
 */
export async function pruneLocalCache(userId: string): Promise<void> {
  const db = getDexieDb(userId)

  // ── Scope-derived: rows for properties the crew member no longer has ──
  const [turnovers, workOrders] = await Promise.all([
    db.turnovers.toArray(),
    db.crew_work_orders.toArray(),
  ])
  const livePropertyIds = new Set<string>([
    ...turnovers.map((t) => t.property_id),
    ...workOrders.map((w) => w.property_id),
  ])

  const [properties, inventory, assets] = await Promise.all([
    db.properties.toArray(),
    db.inventory_items.toArray(),
    db.property_assets.toArray(),
  ])

  await Promise.all([
    db.properties.bulkDelete(properties.filter((p) => !livePropertyIds.has(p.id)).map((p) => p.id)),
    db.inventory_items.bulkDelete(inventory.filter((i) => !livePropertyIds.has(i.property_id)).map((i) => i.id)),
    db.property_assets.bulkDelete(assets.filter((a) => !livePropertyIds.has(a.property_id)).map((a) => a.id)),
  ])

  await pruneExpiredDeadLetters(userId)
  await pruneOrphanPhotoBlobs(userId)
}

/** sync_meta key holding last sweep's unreferenced-but-not-yet-collected blob keys. */
const ORPHAN_CANDIDATES_KEY = 'photo_blob_orphan_candidates'

async function readOrphanCandidates(db: FieldStayDexie): Promise<Set<string>> {
  const row = await db.sync_meta.get(ORPHAN_CANDIDATES_KEY)
  if (!row?.value) return new Set()
  try {
    const parsed: unknown = JSON.parse(row.value)
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    return new Set()
  }
}

/**
 * Collects photo blobs no `pending_photo_uploads` row references.
 *
 * The blob bytes live in a SEPARATE IndexedDB database from the tracking row
 * (see lib/dexie/photo-queue.ts), so the two can never be written atomically:
 * a quota error on the row write, or the PWA being reclaimed between the two,
 * strands the blob with nothing pointing at it. Nothing collected those —
 * pruneExpiredDeadLetters only ever deletes blobs a row still names — so on a
 * device that stays logged in they accumulate at multiple MB each until the
 * browser evicts the whole origin, taking the mutation outbox with it.
 *
 * Two-generation rule: a key is only collected if it was ALSO unreferenced on
 * the previous sweep. Sweeps run at most every safety-poll interval, so that
 * is minutes of margin against deleting a blob whose row is still mid-enqueue
 * — and it needs no timestamp in the key, which the key format is not
 * obliged to carry.
 */
export async function pruneOrphanPhotoBlobs(userId: string): Promise<void> {
  const db = getDexieDb(userId)

  let keys: string[]
  try {
    keys = await listPendingPhotoBlobKeys(userId)
  } catch (err) {
    // Blob-store GC is never worth failing a resync over.
    console.warn('[prune] could not enumerate photo blobs (non-fatal):', err)
    return
  }

  const referenced = new Set((await db.pending_photo_uploads.toArray()).map((p) => p.local_blob_key))
  const unreferenced = keys.filter((key) => !referenced.has(key))

  const priorCandidates = await readOrphanCandidates(db)
  const collectable = unreferenced.filter((key) => priorCandidates.has(key))

  for (const key of collectable) {
    try {
      await deletePendingPhotoBlob(userId, key)
    } catch (err) {
      console.warn('[prune] failed to delete orphaned photo blob:', err)
    }
  }

  // Carry forward only the keys seen unreferenced for the FIRST time.
  await db.sync_meta.put({
    key:   ORPHAN_CANDIDATES_KEY,
    value: JSON.stringify(unreferenced.filter((key) => !priorCandidates.has(key))),
  })
}

/**
 * Collects dead letters the crew member never acted on. Kept separate so a
 * caller can reason about (and a test can assert) that live dead letters —
 * the ones the failed-sync surface is showing right now — are untouched.
 */
export async function pruneExpiredDeadLetters(userId: string): Promise<void> {
  const db = getDexieDb(userId)
  const horizon = daysAgoIso(DEAD_LETTER_RETENTION_DAYS)

  const staleMutations = (await db.mutations.where('failed').equals(1).toArray())
    .filter((m) => m.createdAt < horizon)
  for (const mutation of staleMutations) {
    await db.mutations.delete(mutation.id as number)
    // Same reasoning as discardFailedMutation(): while this row existed,
    // shadowPendingMutations() replayed it over every pull AND the cursor
    // advanced past the server row it masked. Dropping it here — with no user
    // action at all — would otherwise leave the cache pinned to a value the
    // server never accepted, with no path back short of logout.
    await invalidateCursorsFor(userId, mutation.table)
  }

  const stalePhotos = (await db.pending_photo_uploads.where('failed').equals(1).toArray())
    .filter((p) => p.created_at < horizon)
  for (const photo of stalePhotos) {
    await db.pending_photo_uploads.delete(photo.id)
    try {
      // Blob GC — a permanently-failed photo used to leave its bytes in
      // fieldstay-photo-queue-{userId} forever with nothing referencing them.
      await deletePendingPhotoBlob(userId, photo.local_blob_key)
    } catch (err) {
      console.warn('[prune] failed to delete expired photo blob:', err)
    }
  }
}

/**
 * Work that is genuinely still on its way to the server: pending outbox
 * mutations and pending photos, EXCLUDING dead-lettered rows.
 *
 * The logout warning is built on this. Counting dead letters here (as it
 * used to) meant one ancient permanently-failed row made the "unsynced
 * work" confirmation fire on every single logout forever — which trains
 * crew to click through the one dialog that exists to stop them destroying
 * real work. Dead letters get their own, actionable surface instead.
 */
export async function countPendingSyncWork(userId: string): Promise<{ pending: number; deadLettered: number }> {
  const db = getDexieDb(userId)
  const [mutations, photos] = await Promise.all([
    db.mutations.toArray(),
    db.pending_photo_uploads.toArray(),
  ])
  return {
    pending:      mutations.filter((m) => !m.failed).length + photos.filter((p) => !p.failed).length,
    deadLettered: mutations.filter((m) => !!m.failed).length + photos.filter((p) => !!p.failed).length,
  }
}
