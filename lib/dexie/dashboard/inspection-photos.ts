'use client'

// lib/dexie/dashboard/inspection-photos.ts
//
// Capturing an inspection photo, and draining the queue that uploads them.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PATH IS DECIDED AT CAPTURE, NOT AT UPLOAD
//
// One string serves as the local blob key, the object key in the
// `inspection-photos` bucket, and the `photo_path` written onto the answer. It
// is built by `orgScopedStoragePath()`, whose leading org segment is what the
// bucket's RLS policies match on (20260822194607) — a path without it is
// unreachable by every policy, so the upload is denied and no signed URL can
// ever be minted for it.
//
// Deciding it up front is what lets the SUBMIT and the PHOTO travel
// independently. The answer carries the path whether or not the bytes have
// landed, so a sign-off is never held hostage to an upload, and an upload that
// arrives ten minutes later simply fills in an object the report already points
// at. The cost is that a dead-lettered photo leaves an answer referencing a key
// with nothing behind it — visible in the sync banner, and a better failure
// than a walk that cannot be filed.
//
// ─────────────────────────────────────────────────────────────────────────────
// BESPOKE DRAIN, FOR THE REASON THE VENDOR ONE ALREADY GIVES
//
// Not OutboxEngine. `lib/dexie/vendorWoPhotoSync.ts` records why: "a synced
// photo row must be KEPT with a serverId (so the grid still shows it after a
// reload), whereas OutboxEngine's contract deletes the row on success." Same
// shape here — the row flips to `uploaded` and stays, so the UI can tell "no
// photo" from "photo taken, still sending". Both existing photo drains in this
// codebase are bespoke for this reason; this follows them rather than forking
// the mutation engine into a shape it does not fit.

import { compressPhoto } from '@/lib/images/compress'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/observability/report-error'
import { orgScopedStoragePath } from '@/lib/storage/object-path'
import { classifyUploadFailure, isOnline, withTabLock } from '../net'
import { computeNextAttemptAt } from '../outbox-primitives'

import { getDashboardDb, type DashboardPendingPhotoRow } from './schema'

const BUCKET = 'inspection-photos'

/**
 * Dead-letter after this many real rejections.
 *
 * Transport failures do not count against it — see the drain. Matched to the
 * mutation outbox so a PM does not have to learn two different notions of
 * "given up".
 */
const MAX_RETRIES = 5

export interface CaptureResult {
  ok:   boolean
  /** The object key, which is also what goes on the answer as `photo_path`. */
  path?: string
  error?: string
}

/**
 * Compresses a captured image and queues it, atomically.
 *
 * The blob, its queue row, and the answer that references it commit in ONE
 * Dexie transaction. That is the whole reason the bytes live in this database
 * rather than the separate one the crew PWA uses: its own comment records that
 * a blob and its row "can never be written atomically… the blob is stranded
 * with nothing pointing at it", and at multiple MB each those strays push the
 * origin toward evicting the entire offline cache, mutation outbox included.
 */
export async function captureInspectionPhoto(
  userId: string,
  orgId:  string,
  input:  { inspectionId: string; answerRowId: string; file: Blob },
): Promise<CaptureResult> {
  const db = getDashboardDb(userId, orgId)

  try {
    // Compression is OUTSIDE the transaction: it is async and CPU-bound, and an
    // IndexedDB transaction auto-commits the moment an await leaves it.
    const compressed = await compressPhoto(input.file)

    const path = orgScopedStoragePath(
      orgId, 'inspections', input.inspectionId, `${crypto.randomUUID()}.jpg`,
    )
    const now = new Date().toISOString()

    await db.transaction('rw',
      db.photo_blobs, db.pending_photo_uploads, db.inspection_answers,
      async () => {
        await db.photo_blobs.put({ key: path, blob: compressed })
        await db.pending_photo_uploads.add({
          id:          path,
          orgId,
          targetId:    input.inspectionId,
          answerRowId: input.answerRowId,
          blobKey:     path,
          mimeType:    compressed.type || 'image/jpeg',
          status:      'pending',
          retryCount:  0,
          failed:      0,
          createdAt:   now,
        })
        // Written straight onto the answer. The Review gate reads `photoPath`,
        // so the item stops being outstanding the moment the picture is taken
        // rather than when it finishes uploading — which is correct: the
        // inspector has done their part.
        //
        // Table.update() is a documented no-op on a missing key — it resolves
        // with 0, it does not throw or reject the transaction. If this photo
        // is the item's FIRST interaction (plausible for a photo-evidence-only
        // question, before saveAnswer has ever created this answerKey's row),
        // that silently drops the photo's only link to the inspection: the
        // blob uploads successfully, but nothing on the answer ever points at
        // it, and Review/the final report both show the item as
        // un-photographed with no error anywhere. Checking the count and
        // throwing rolls back the blob/queue writes too, which is correct —
        // an orphaned queued photo with nothing to show for it is exactly the
        // failure this closes.
        const updated = await db.inspection_answers.update(input.answerRowId, {
          photoPath: path,
          // A photo supersedes the reason there wasn't one. Leaving both would
          // put "camera failed" on a report next to the photograph.
          photoUnavailableReason: null,
          updatedAt: now,
        })
        if (updated === 0) {
          throw new Error(`No answer row "${input.answerRowId}" to attach photo to`)
        }
      })

    // Kicked, not awaited — a capture must return the instant the bytes are
    // safely in IndexedDB, so the inspector can take the next photo while this
    // one uploads. Anyone who does want to wait can await the same promise.
    void drainInspectionPhotos(userId, orgId)
    return { ok: true, path }
  } catch (err) {
    console.error('[captureInspectionPhoto]', err)
    reportError(err, { site: 'dexie.dashboard.captureInspectionPhoto' })
    return { ok: false, error: 'Could not save that photo. Please try again.' }
  }
}

/** Removes a queued photo and its bytes, and clears it off the answer. */
export async function discardInspectionPhoto(
  userId: string,
  orgId:  string,
  input:  { answerRowId: string; path: string },
): Promise<void> {
  const db = getDashboardDb(userId, orgId)
  await db.transaction('rw',
    db.photo_blobs, db.pending_photo_uploads, db.inspection_answers,
    async () => {
      await db.photo_blobs.delete(input.path)
      await db.pending_photo_uploads.delete(input.path)
      await db.inspection_answers.update(input.answerRowId, {
        photoPath: null,
        updatedAt: new Date().toISOString(),
      })
    })
}

/**
 * Drops queue rows for photos that have already finished uploading.
 *
 * A row survives its own upload deliberately — see the header comment: the
 * UI distinguishes "no photo" from "photo taken, still sending" by whether
 * the row exists at all, and `uploadOne()` already deletes the BLOB the
 * moment the server has the bytes, leaving only this bookkeeping row behind.
 * Left in place forever, that row count only grows: every photo capture and
 * every reconnect calls `drainInspectionPhotos()`, which (before this fix)
 * read the WHOLE table on every one of those, uploaded rows included, and by
 * the time a PM has run a season of inspections nothing will ever act on most
 * of them again.
 *
 * Called at the same lifecycle point as `pruneFinishedInspections()`
 * (inspection-draft.ts) — the fill screen's mount — since both exist for the
 * identical reason and neither has anything the other needs to sequence
 * against.
 */
export async function pruneUploadedPhotoRows(userId: string, orgId: string): Promise<void> {
  const db = getDashboardDb(userId, orgId)
  // Index-backed: `status` is exactly what separates "done, never touched
  // again" from every row a query elsewhere still needs to find.
  const stale = await db.pending_photo_uploads.where('status').equals('uploaded').primaryKeys()
  if (stale.length === 0) return
  await db.pending_photo_uploads.bulkDelete(stale)
}

/**
 * The drain in flight for each (user, org), so a concurrent caller AWAITS it
 * rather than being turned away.
 *
 * A plain `Set` guard — return immediately if already draining — is what the
 * other two photo syncs use, and it is subtly wrong for anyone who awaits:
 * `await drainInspectionPhotos(...)` right after a capture would resolve
 * instantly having done nothing, because the capture's own fire-and-forget kick
 * still held the flag. In production that only costs latency, since the next
 * mount or reconnect drains anyway. It is still a promise the function was not
 * keeping, and returning the in-flight promise costs nothing to keep it.
 */
const inFlight = new Map<string, Promise<void>>()

/**
 * How many INSPECTIONS' worth of photos this drain uploads at once.
 *
 * Photos have no ordering relationship with each other (unlike the mutation
 * outbox's `inspection.create` → `inspection.submit` dependency) — see the
 * header comment. Partitioning by `targetId` (the inspection each photo
 * belongs to) and draining a handful of inspections concurrently is
 * therefore purely a head-of-line-blocking fix, not a correctness change:
 * a stuck upload on one inspection's photo used to block EVERY OTHER
 * inspection's photos behind it in the same strict queue, and the deeper the
 * queue the worse that got — a PM who ran ten inspections in one day with one
 * photo silently rejected on the first would see all nine others stall too.
 * Bounded rather than unbounded so a portfolio-wide catch-up sync (many
 * inspections, one per property) does not open dozens of simultaneous
 * Storage uploads at once.
 */
const MAX_CONCURRENT_PARTITIONS = 4

/**
 * Uploads every queued photo for this (user, org).
 *
 * Mirrors the vendor drain's shape: an in-process guard, insertion order
 * WITHIN each inspection's own photos, and a retry policy where a TRANSPORT
 * failure costs no budget. That last part is the one worth stating — a
 * tablet in a basement would otherwise burn all five attempts on "no
 * network" and dead-letter a photograph that was never actually rejected by
 * anything.
 *
 * Never throws. A photo that cannot upload must not take the walk with it.
 */
export function drainInspectionPhotos(userId: string, orgId: string): Promise<void> {
  const lockKey = `${userId}-${orgId}`
  const existing = inFlight.get(lockKey)
  if (existing) return existing
  if (!isOnline()) return Promise.resolve()

  const run = runDrain(userId, orgId).finally(() => { inFlight.delete(lockKey) })
  inFlight.set(lockKey, run)
  return run
}

async function runDrain(userId: string, orgId: string): Promise<void> {
  const lockKey = `${userId}-${orgId}`
  try {
    await withTabLock(`fieldstay-dashboard-photos-${lockKey}`, async () => {
      const db = getDashboardDb(userId, orgId)
      // Index-backed on `status`, not `.toArray()` — see schema.ts version(6).
      // Uploaded rows are only ever status-flipped, never deleted on their
      // own (pruneUploadedPhotoRows() is what actually removes them), so an
      // unfiltered scan here re-read every photo this device has EVER
      // queued, on every capture and every reconnect.
      const pending = (await db.pending_photo_uploads.where('status').equals('pending').toArray())
        .filter((r) => !r.failed)
        .filter((r) => !r.nextAttemptAt || r.nextAttemptAt <= Date.now())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

      const partitions = new Map<string, DashboardPendingPhotoRow[]>()
      for (const row of pending) {
        const list = partitions.get(row.targetId)
        if (list) list.push(row)
        else partitions.set(row.targetId, [row])
      }

      await runPartitionsConcurrently(
        [...partitions.values()],
        MAX_CONCURRENT_PARTITIONS,
        (rows) => drainPartition(userId, orgId, rows),
      )
    })
  } catch (err) {
    console.warn('[drainInspectionPhotos] drain failed (non-fatal):', err)
  }
}

/** One inspection's photos, in order, stopping at the first failure. */
async function drainPartition(
  userId: string,
  orgId:  string,
  rows:   DashboardPendingPhotoRow[],
): Promise<void> {
  for (const row of rows) {
    const done = await uploadOne(userId, orgId, row)
    // Stop on the first failure within THIS inspection's own photos rather
    // than skipping ahead — a run of failures inside one partition is almost
    // always one cause (a lost connection, a policy denial), and hammering
    // the rest of that inspection's queue against it just burns retry budget
    // in parallel. Never affects any OTHER inspection's partition, which is
    // the whole point of partitioning.
    if (!done) break
  }
}

/**
 * Runs each partition to completion, at most `limit` running at once.
 *
 * `run()` never throws — `drainPartition()`'s only call is `uploadOne()`,
 * which classifies every failure into a row update rather than rejecting —
 * so this pool is purely about concurrency, not error propagation between
 * partitions.
 */
async function runPartitionsConcurrently<T>(
  items: T[],
  limit: number,
  run:   (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await run(item)
    }
  })
  await Promise.all(workers)
}

/** True when the row is finished with; false when the drain should stop. */
async function uploadOne(
  userId: string,
  orgId:  string,
  row:    DashboardPendingPhotoRow,
): Promise<boolean> {
  const db = getDashboardDb(userId, orgId)

  const stored = await db.photo_blobs.get(row.blobKey)
  if (!stored) {
    // The bytes are gone — storage pressure, or a cleanup that outran its row.
    // Nothing can recover it, so dead-letter rather than retry forever: the
    // banner then says a photo was lost, which is the honest outcome and the
    // one an inspector can act on by retaking it.
    await db.pending_photo_uploads.update(row.id, {
      failed: 1, lastError: 'The image was no longer on this device.',
    })
    return true
  }

  try {
    const { error } = await createClient().storage
      .from(BUCKET)
      .upload(row.blobKey, stored.blob, {
        contentType: row.mimeType,
        // A replay must not 409 on an object the previous attempt already
        // wrote. The key is a UUID minted at capture, so an upsert can only
        // ever overwrite this photo's own earlier attempt.
        upsert: true,
      })
    if (error) throw error

    await db.transaction('rw', db.photo_blobs, db.pending_photo_uploads, async () => {
      // Row KEPT, status flipped — the UI distinguishes "no photo" from
      // "photo taken, still sending". Only the bytes go, and only once the
      // server has them.
      await db.pending_photo_uploads.update(row.id, {
        status: 'uploaded', failed: 0, lastError: undefined,
      })
      await db.photo_blobs.delete(row.blobKey)
    })
    return true
  } catch (err) {
    return handleFailure(userId, orgId, row, err)
  }
}

async function handleFailure(
  userId: string,
  orgId:  string,
  row:    DashboardPendingPhotoRow,
  err:    unknown,
): Promise<boolean> {
  const db = getDashboardDb(userId, orgId)
  const kind = classifyUploadFailure(err)

  if (kind === 'network') {
    // No retry budget spent. The request never reached anything that could
    // reject it, so counting it would let a drive through a dead zone
    // dead-letter a perfectly good photograph.
    const networkRetryCount = (row.networkRetryCount ?? 0) + 1
    await db.pending_photo_uploads.update(row.id, {
      networkRetryCount,
      nextAttemptAt: computeNextAttemptAt(networkRetryCount, Date.now()),
    })
    return false
  }

  const retryCount = row.retryCount + 1
  // 'terminal' reached the server and was rejected in a way replay cannot fix
  // — a policy denial, a bad content type. Spending five attempts to rediscover
  // that only delays the banner telling the inspector to retake it.
  if (kind === 'terminal' || retryCount >= MAX_RETRIES) {
    await db.pending_photo_uploads.update(row.id, {
      retryCount,
      failed: 1,
      // Short and user-safe. NEVER the blob or the path's tail — the banner is
      // read by a PM, and the raw error can carry storage internals.
      lastError: 'This photo could not be uploaded.',
    })
    // Finished with, in the sense the drain cares about: move on.
    return true
  }

  reportError(err, { site: 'dexie.dashboard.inspectionPhotoUpload' })
  await db.pending_photo_uploads.update(row.id, {
    retryCount,
    nextAttemptAt: computeNextAttemptAt(retryCount, Date.now()),
  })
  return false
}
