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
