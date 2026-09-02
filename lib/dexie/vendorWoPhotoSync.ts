import {
  getVendorWoDb,
  type VendorPendingPhotoRow,
} from './vendorWoSchema'
import {
  saveVendorPendingPhotoBlob,
  getVendorPendingPhotoBlob,
  deleteVendorPendingPhotoBlob,
} from './vendorPhotoQueue'
import { compressPhoto } from '@/lib/images/compress'

import { reportError } from '@/lib/observability/report-error'
const MAX_RETRIES = 5

// Mirrors uploadVendorCompletion's terminal/transient split in
// vendorWoSyncService.ts — a 400/403/404/409/410 response means either the
// upload itself was rejected or the work order is closed/expired/portal-
// disabled, and a missing local blob means there's nothing left to
// upload. Neither can ever succeed no matter how many times it's retried.
class TerminalPhotoError extends Error {}

const EXT_BY_MIME: Record<string, string> = {
  'image/png':  'png',
  'image/webp': 'webp',
}

async function uploadOnePhoto(token: string, row: VendorPendingPhotoRow): Promise<string> {
  const blob = await getVendorPendingPhotoBlob(token, row.blobKey)
  if (!blob) throw new TerminalPhotoError('Queued photo is no longer available locally')

  const ext  = EXT_BY_MIME[row.mimeType] ?? 'jpg'
  const body = new FormData()
  body.append('photos', blob, `photo.${ext}`)
  body.append('uploadedBy', row.uploadedBy)

  const res = await fetch(`/api/work-orders/${token}/photos`, { method: 'POST', body })

  if (!res.ok) {
    if ([400, 403, 404, 409, 410].includes(res.status)) {
      throw new TerminalPhotoError(`Photo upload rejected: ${res.status}`)
    }
    throw new Error(`Photo upload failed: ${res.status}`)
  }

  const resBody = await res.json().catch(() => ({}))
  const uploadedId = resBody.uploaded?.[0]?.id as string | undefined
  if (!uploadedId) throw new Error('Photo upload response missing id')
  return uploadedId
}

const processingTokens = new Set<string>()

/** What the drain should do after one photo failed. */
type DrainDecision = 'next' | 'stop'

/**
 * Records one photo's failure and decides whether the drain continues.
 *
 * Extracted from the loop's catch block rather than left inline: the branching
 * sat five levels deep (try > for > try/catch > if > if), and the decision it
 * produces is the only thing the loop actually needs back.
 */
async function recordPhotoFailure(
  db:  ReturnType<typeof getVendorWoDb>,
  row: VendorPendingPhotoRow,
  err: unknown,
): Promise<DrainDecision> {
  const id = row.id as number

  if (err instanceof TerminalPhotoError) {
    console.error(`[vendorWoPhotoSync] photo ${id} terminal failure:`, err.message)
    reportError(err, { site: 'lib.dexie.vendorWoPhotoSync.vendorWoPhotoSync' })
    await db.pendingPhotos.update(id, { status: 'failed' })
    return 'next'
  }

  const newRetryCount = row.retryCount + 1
  console.error(`[vendorWoPhotoSync] photo ${id} failed (attempt ${newRetryCount}):`, err)

  if (newRetryCount >= MAX_RETRIES) {
    await db.pendingPhotos.update(id, { retryCount: newRetryCount, status: 'failed' })
    return 'next'
  }

  await db.pendingPhotos.update(id, { retryCount: newRetryCount })
  // Early attempts stop the drain so a transient failure does not burn the
  // retry budget of every photo behind it; from attempt 3 the backoff is long
  // enough that carrying on is the better trade.
  return newRetryCount >= 3 ? 'next' : 'stop'
}

/**
 * Drains pending photo uploads for one vendor token. Bespoke rather than
 * OutboxEngine (lib/dexie/outboxEngine.ts) — a synced photo row must be
 * KEPT with a serverId (so the grid still shows it after a reload),
 * whereas OutboxEngine's contract deletes the row on success. Mirrors
 * OutboxEngine's isProcessing guard, insertion-order drain, and graduated
 * retry policy (stop the queue at 1-2 failed attempts, skip-and-continue
 * at 3-4, dead-letter at 5) for consistency with the rest of the sync layer.
 */
export async function processPendingVendorPhotoUploads(token: string): Promise<void> {
  if (processingTokens.has(token)) return
  processingTokens.add(token)

  try {
    const db = getVendorWoDb(token)
    const pending = (await db.pendingPhotos.where('token').equals(token).toArray())
      .filter((r) => r.status === 'pending')
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))

    for (const row of pending) {
      const id = row.id as number
      try {
        const serverId = await uploadOnePhoto(token, row)
        await db.pendingPhotos.update(id, { status: 'uploaded', serverId })
        await deleteVendorPendingPhotoBlob(token, row.blobKey)
      } catch (err) {
        if (await recordPhotoFailure(db, row, err) === 'stop') break
      }
    }
  } finally {
    processingTokens.delete(token)
  }
}

/**
 * Compresses and queues a photo locally, then kicks off an immediate drain
 * attempt in the background — the row appears in the useLiveQuery-driven
 * grid right away regardless of whether the upload attempt that follows
 * succeeds, fails transiently, or the device has no connection at all.
 */
export async function queueVendorPhotoUpload(token: string, file: File, uploadedBy: string): Promise<number> {
  const compressed = await compressPhoto(file)
  const blobKey = crypto.randomUUID()
  await saveVendorPendingPhotoBlob(token, blobKey, compressed)

  const db = getVendorWoDb(token)
  const id = await db.pendingPhotos.add({
    token,
    blobKey,
    mimeType:   compressed.type || file.type,
    uploadedBy,
    status:     'pending',
    retryCount: 0,
    createdAt:  new Date().toISOString(),
  })

  void processPendingVendorPhotoUploads(token)
  return id
}

/** Re-queues a dead-lettered (failed) photo for a manual "Retry" tap. */
export async function retryVendorPhotoUpload(token: string, photoRowId: number): Promise<void> {
  const db = getVendorWoDb(token)
  await db.pendingPhotos.update(photoRowId, { status: 'pending', retryCount: 0 })
  await processPendingVendorPhotoUploads(token)
}

/**
 * Removes a queued/uploaded photo the vendor decided to take back. For an
 * already-uploaded photo, the server-side delete is attempted FIRST and
 * local state is only cleared once it's confirmed — deleting the local row
 * up front would leave an orphaned work_order_photos row/storage object
 * with nothing left on the device to retry the deletion from if the
 * network request fails or the server rejects it. Returns false (and
 * leaves everything in place) when that happens, so the caller can tell
 * the vendor it didn't go through instead of silently believing it did.
 */
export async function removeVendorPendingPhoto(token: string, photoRowId: number): Promise<boolean> {
  const db = getVendorWoDb(token)
  const row = await db.pendingPhotos.get(photoRowId)
  if (!row) return true

  if (row.status === 'uploaded' && row.serverId) {
    try {
      const res = await fetch(`/api/work-orders/${token}/photos`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ photoId: row.serverId }),
      })
      if (!res.ok) {
        console.error(`[vendorWoPhotoSync] server rejected delete of photo row ${photoRowId} (status ${res.status}) — keeping local row`)
        return false
      }
    } catch (err) {
      console.error(`[vendorWoPhotoSync] network error deleting photo row ${photoRowId} — keeping local row`, err)
      reportError(err, { site: 'lib.dexie.vendorWoPhotoSync.vendorWoPhotoSync' })
      return false
    }
  }

  await db.pendingPhotos.delete(photoRowId)
  await deleteVendorPendingPhotoBlob(token, row.blobKey)
  return true
}
