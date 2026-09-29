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
import { getCursor, invalidateCursorsFor } from './sync/cursors'

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
 * Ids with outbox work still attached, across BOTH queues and in every state.
 *
 * "Every state" is deliberate. A dead-lettered row and a stalled one are the
 * two shapes a write takes when it has NOT reached the server, and a transport
 * failure never sets `failed` at all — so filtering to pending rows here would
 * retain exactly the mutations that are fine and drop the cache rows belonging
 * to the ones that are not.
 *
 * Photos are the reason this exists rather than a nicety. photo-sync resolves
 * a queued photo's storage org prefix by walking the LOCAL cache —
 * checklist_instance_items -> checklist_instances -> org_id — and
 * orgPrefixedUploadPath returns null the moment that item row is gone. A null
 * there is a bounded, backed-off failure and then a dead letter: a crew
 * member's photograph thrown away by a cache cleanup, which is the precise
 * failure the dead-letter surface exists to prevent.
 */
async function idsWithPendingWork(db: FieldStayDexie): Promise<Set<string>> {
  const [mutations, photos] = await Promise.all([
    db.mutations.toArray(),
    db.pending_photo_uploads.toArray(),
  ])
  const busy = new Set<string>()
  for (const m of mutations) busy.add(m.targetId)
  for (const p of photos)    busy.add(p.target_id)
  return busy
}

/**
 * Drops checklist ITEM rows for turnovers whose checklist finished long enough
 * ago that the delta cursor has moved past them.
 *
 * ── Why items, and why not the turnover ────────────────────────────────────
 *
 * checklist_instance_items is the whole retention problem: measured at 872
 * properties, it is 100MB of a 104MB device cache and it grows with a crew
 * member's TENURE rather than with anything about today.
 *
 * Purging the TURNOVER instead does not work, and the reason is structural:
 * partitionByKnown() reclassifies an id the device no longer holds as `fresh`,
 * and fresh ids are pulled WITHOUT a cursor, so the row and its whole checklist
 * come straight back on the next sync — every sync, forever. Items have no such
 * path: fetchWithCursorSplit splits on TURNOVER id, never on item id, so while
 * the turnover row stays cached its items are only ever re-fetched by
 * `.gt('updated_at', cursor)`. Deleting them is therefore durable, and keeping
 * the turnover row is what makes it durable.
 *
 * ── Why the cursor is the predicate, and not "is it completed" ─────────────
 *
 * "Purge on a successful completion sync" thrashes, which a simulation against
 * the real sync path showed before any of this was written (see
 * unit/dexie/crew-cache-retention-behaviour.test.ts, HOLE 3). advanceCursor
 * stores max(updated_at) - CURSOR_OVERLAP_MS, so a turnover completed moments
 * ago sits INSIDE that overlap window: purge it and the next delta pull returns
 * all of its items, and the pass after that purges them again. A permanent
 * purge/re-pull loop on the most recent job — which is also the one a crew
 * member is most likely to reopen.
 *
 * Comparing against the cursor itself removes the guesswork instead of adding
 * a settle-delay constant that would have to be kept in step with
 * CURSOR_OVERLAP_MS by hand. `completed_at < cursor` is exactly the condition
 * "the next delta pull will not return these rows", stated once, derived from
 * the same value the pull uses.
 *
 * completed_at comes off the cached checklist_instances row: item rows drop
 * updated_at during normalization (it feeds the cursor, not the cache), so the
 * instance is the only local record of when this checklist settled. A NULL
 * completed_at is never purged — unfinished, or an unknown, both mean keep.
 *
 * Returns the number of item rows removed.
 */
export async function pruneSettledChecklistItems(userId: string): Promise<number> {
  const db = getDexieDb(userId)

  // No cursor means the next pull is a FULL pull of the whole scope, so
  // anything removed now returns immediately. Nothing to do but wait for one.
  const cursor = await getCursor(userId, 'cursor:checklist_items')
  if (cursor === null) return 0

  const instances = await db.checklist_instances.toArray()
  const settled = instances.filter(
    (i) => i.completed_at !== null && i.completed_at !== undefined && i.completed_at < cursor,
  )
  if (!settled.length) return 0

  const settledInstanceIds = new Set(settled.map((i) => i.id))
  const items = await db.checklist_instance_items.toArray()
  const candidates = items.filter((i) => settledInstanceIds.has(i.instance_id))
  if (!candidates.length) return 0

  // Retain a whole checklist when ANY part of it still has unsent work — the
  // item, its instance, or the turnover. Per-item would strand a photo whose
  // sibling rows had gone, and the photo path walks item -> instance.
  const busy = await idsWithPendingWork(db)
  const busyInstanceIds = new Set(
    settled
      .filter((i) => busy.has(i.id) || busy.has(i.turnover_id))
      .map((i) => i.id),
  )
  for (const item of candidates) {
    if (busy.has(item.id)) busyInstanceIds.add(item.instance_id)
  }

  const doomed = candidates.filter((i) => !busyInstanceIds.has(i.instance_id))
  if (!doomed.length) return 0

  await db.checklist_instance_items.bulkDelete(doomed.map((i) => i.id))
  return doomed.length
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

  // Runs on every resync, which is also the tail of forceFullCrewResync — so
  // the repair path re-pulls the full history and then sheds it again in the
  // same pass, rather than leaving the device inflated until something else
  // happens to clean up.
  await pruneSettledChecklistItems(userId)

  await pruneExpiredDeadLetters(userId)
  await pruneOrphanPhotoBlobs(userId)
  await pruneReportedSyncIncidents(userId)
}

/**
 * How long a REPORTED sync incident stays on the device before it's
 * collected. Deliberately longer than DEAD_LETTER_RETENTION_DAYS — this is a
 * support/monitoring signal a PM or engineer may need to look back on well
 * after the underlying write was retried or abandoned, not just past the
 * point a crew member could still retry it themselves. 400 days ("Show me
 * what happened" — Implementation Instructions, section 3.2) is comfortably
 * past a full year plus a season.
 */
export const SYNC_INCIDENT_RETENTION_DAYS = 400

/**
 * Collects only incidents the server has ack'd (`reported = 1`) and past
 * retention. An UNREPORTED incident is never collected here regardless of
 * age — it is the only evidence a dead-letter or stall ever happened, and
 * this table is what the sync-reliability monitoring/support signal reads.
 * See discardFailedMutation()/pruneExpiredDeadLetters() above for the same
 * rule applied to the mutation/photo outboxes.
 */
export async function pruneReportedSyncIncidents(userId: string): Promise<void> {
  const db = getDexieDb(userId)
  const horizon = daysAgoIso(SYNC_INCIDENT_RETENTION_DAYS)

  const stale = (await db.sync_incidents.where('reported').equals(1).toArray())
    .filter((incident) => incident.occurredAt < horizon)
  for (const incident of stale) {
    await db.sync_incidents.delete(incident.id as number)
  }
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
