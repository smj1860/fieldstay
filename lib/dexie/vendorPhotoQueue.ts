// lib/dexie/vendorPhotoQueue.ts
//
// Raw IndexedDB blob store for vendor-portal completion photos captured
// while offline. Mirrors lib/dexie/photo-queue.ts's shape exactly, but
// keyed per completion-token instead of per-userId — a vendor has no
// auth.uid(), so the token is the only natural per-session key available.
// Per-token isolation means two different vendor links opened on the same
// device can never collide, by construction, with no cleanup logic needed.

const STORE_NAME = 'photos'
const DB_VERSION = 1

function dbName(token: string): string {
  return `fieldstay-vendor-photo-queue-${token}`
}

function openDb(token: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(token), DB_VERSION)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME) }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

export async function saveVendorPendingPhotoBlob(token: string, key: string, blob: Blob): Promise<void> {
  const db = await openDb(token)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(blob, key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
  db.close()
}

export async function getVendorPendingPhotoBlob(token: string, key: string): Promise<Blob | null> {
  const db = await openDb(token)
  const result = await new Promise<Blob | null>((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null)
    req.onerror   = () => reject(req.error)
  })
  db.close()
  return result
}

export async function deleteVendorPendingPhotoBlob(token: string, key: string): Promise<void> {
  const db = await openDb(token)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
  db.close()
}
