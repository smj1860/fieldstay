// lib/dexie/photo-queue.ts
//
// Minimal IndexedDB blob store for photos captured while offline. The
// pending_photo_uploads Dexie table tracks which target row each queued
// photo belongs to; the actual image bytes live here.
//
// Namespaced per-userId (HIGH-2): a fixed database name let a second crew
// member's blobs collide with the first's if they logged in before the
// first user's photos finished syncing.

const STORE_NAME = 'photos'
const DB_VERSION = 1

function dbName(userId: string): string {
  return `fieldstay-photo-queue-${userId}`
}

function openDb(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(userId), DB_VERSION)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME) }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

/**
 * Downscales and re-compresses a camera photo before it's queued to
 * IndexedDB. Full-resolution camera photos (3-8MB+ on modern phones)
 * queued uncompressed across a multi-item checklist can exhaust IndexedDB
 * quota, especially under iOS Safari's more aggressive eviction. 1600px
 * longest edge / JPEG quality 0.75 is well beyond what a checklist
 * verification photo needs to be useful to a PM reviewing it.
 */
export async function compressPhotoForQueue(
  file: Blob,
  maxDimension = 1600,
  quality = 0.75,
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale  = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    const width  = Math.round(bitmap.width  * scale)
    const height = Math.round(bitmap.height * scale)

    const canvas = document.createElement('canvas')
    canvas.width  = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return file // no 2d context available — fall back to the original
    }

    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    )
    return blob ?? file
  } catch (err) {
    // Non-fatal — compression is a size optimization, not a correctness
    // requirement. Fall back to the original file rather than blocking the
    // crew member's checklist progress on a canvas/codec quirk.
    console.warn('[photo-queue] compression failed, storing original:', err)
    return file
  }
}

export async function savePendingPhotoBlob(userId: string, key: string, blob: Blob): Promise<void> {
  const db = await openDb(userId)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(blob, key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
  db.close()
}

export async function getPendingPhotoBlob(userId: string, key: string): Promise<Blob | null> {
  const db = await openDb(userId)
  const result = await new Promise<Blob | null>((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null)
    req.onerror   = () => reject(req.error)
  })
  db.close()
  return result
}

/**
 * Every blob key currently held for this user.
 *
 * Exists so lib/dexie/prune.ts can find blobs nothing references any more.
 * This store is a SEPARATE IndexedDB database from the crew cache that holds
 * the `pending_photo_uploads` tracking rows, so a blob and its row can never
 * be written atomically: if the row write throws (quota) or the PWA is
 * reclaimed between the two, the blob is stranded with nothing pointing at it.
 * Nothing collected those, and at multiple MB each they push the origin toward
 * eviction of the entire offline cache — including the mutation outbox.
 */
export async function listPendingPhotoBlobKeys(userId: string): Promise<string[]> {
  const db = await openDb(userId)
  const keys = await new Promise<string[]>((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys()
    req.onsuccess = () => resolve(req.result as string[])
    req.onerror   = () => reject(req.error)
  })
  db.close()
  return keys
}

export async function deletePendingPhotoBlob(userId: string, key: string): Promise<void> {
  const db = await openDb(userId)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
  db.close()
}
