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
          id:         path,
          orgId,
          targetId:   input.inspectionId,
          blobKey:    path,
          mimeType:   compressed.type || 'image/jpeg',
          status:     'pending',
          retryCount: 0,
          failed:     0,
          createdAt:  now,
        })
        // Written straight onto the answer. The Review gate reads `photoPath`,
        // so the item stops being outstanding the moment the picture is taken
        // rather than when it finishes uploading — which is correct: the
        // inspector has done their part.
        await db.inspection_answers.update(input.answerRowId, {
          photoPath: path,
          // A photo supersedes the reason there wasn't one. Leaving both would
          // put "camera failed" on a report next to the photograph.
          photoUnavailableReason: null,
          updatedAt: now,
        })
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
 * Uploads every queued photo for this (user, org).
 *
 * Mirrors the vendor drain's shape: an in-process guard, insertion order, and
 * a retry policy where a TRANSPORT failure costs no budget. That last part is
 * the one worth stating — a tablet in a basement would otherwise burn all five
 * attempts on "no network" and dead-letter a photograph that was never actually
 * rejected by anything.
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
      const pending = (await db.pending_photo_uploads.toArray())
        .filter((r) => r.status === 'pending' && !r.failed)
        .filter((r) => !r.nextAttemptAt || r.nextAttemptAt <= Date.now())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

      for (const row of pending) {
        const done = await uploadOne(userId, orgId, row)
        // Stop on the first failure rather than skipping ahead. Photos have no
        // ordering relationship with each other, but a run of failures is
        // almost always one cause — a lost connection — and hammering the rest
        // of the queue against it just burns retry budget in parallel.
        if (!done) break
      }
    })
  } catch (err) {
    console.warn('[drainInspectionPhotos] drain failed (non-fatal):', err)
  }
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
