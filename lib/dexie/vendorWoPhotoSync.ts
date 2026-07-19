import {
  getVendorWoDb,
  type VendorPendingPhotoRow,
} from './vendorWoSchema'
import {
  saveVendorPendingPhotoBlob,
  getVendorPendingPhotoBlob,
  deleteVendorPendingPhotoBlob,
} from './vendorPhotoQueue'
import { compressPhotoForQueue } from './photo-queue'

const MAX_RETRIES = 5

// Mirrors uploadVendorCompletion's terminal/transient split in
// vendorWoSyncService.ts — a 400/403/404/409/410 response means either the
// upload itself was rejected or the work order is closed/expired/portal-
// disabled, and a missing local blob means there's nothing left to
// upload. Neither can ever succeed no matter how many times it's retried.
class TerminalPhotoError extends Error {}

async function uploadOnePhoto(token: string, row: VendorPendingPhotoRow): Promise<string> {
  const blob = await getVendorPendingPhotoBlob(token, row.blobKey)
  if (!blob) throw new TerminalPhotoError('Queued photo is no longer available locally')

  const ext  = row.mimeType === 'image/png' ? 'png' : row.mimeType === 'image/webp' ? 'webp' : 'jpg'
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
        if (err instanceof TerminalPhotoError) {
          console.error(`[vendorWoPhotoSync] photo ${id} terminal failure:`, err.message)
          await db.pendingPhotos.update(id, { status: 'failed' })
          continue
        }

        const newRetryCount = row.retryCount + 1
        console.error(`[vendorWoPhotoSync] photo ${id} failed (attempt ${newRetryCount}):`, err)
        if (newRetryCount >= MAX_RETRIES) {
          await db.pendingPhotos.update(id, { retryCount: newRetryCount, status: 'failed' })
        } else {
          await db.pendingPhotos.update(id, { retryCount: newRetryCount })
          if (newRetryCount >= 3) continue
          break
        }
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
  const compressed = await compressPhotoForQueue(file)
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
 * Removes a queued/uploaded photo the vendor decided to take back. Handles
 * both "still local-only" (delete the blob + row) and "already uploaded
 * server-side" (also issue the DELETE to remove it from
 * work_order_photos/storage) cases.
 */
export async function removeVendorPendingPhoto(token: string, photoRowId: number): Promise<void> {
  const db = getVendorWoDb(token)
  const row = await db.pendingPhotos.get(photoRowId)
  if (!row) return

  await db.pendingPhotos.delete(photoRowId)
  await deleteVendorPendingPhotoBlob(token, row.blobKey)

  if (row.status === 'uploaded' && row.serverId) {
    try {
      await fetch(`/api/work-orders/${token}/photos`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ photoId: row.serverId }),
      })
    } catch (err) {
      console.error('[vendorWoPhotoSync] failed to delete uploaded photo server-side', err)
    }
  }
}
