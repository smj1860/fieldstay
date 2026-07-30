import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, type FakeDexieDb } from './fake-dexie'
import type { PendingPhotoUploadRow } from '@/lib/dexie/schema'

// Queued photos used to be destroyed after ~2.5 minutes offline: the drain
// ran unconditionally on a 30 s interval, had no backoff, incremented
// retry_count on every failure, and after five ticks the row fell out of
// `.where('retry_count').below(MAX_RETRIES)` and was never retried again —
// with no failed-photo UI anywhere and the blob orphaned in
// fieldstay-photo-queue-*. Meanwhile the checklist item had already been
// marked complete, so the PM saw a photo-required item with no photo and no
// error.

const holder = vi.hoisted(() => ({ db: null as unknown, blob: null as unknown }))

vi.mock('@/lib/dexie/schema', () => ({ getDexieDb: () => holder.db }))
vi.mock('./schema', () => ({ getDexieDb: () => holder.db }))

const deletedBlobs: string[] = []
vi.mock('@/lib/dexie/photo-queue', () => ({
  getPendingPhotoBlob: async () => holder.blob,
  deletePendingPhotoBlob: async (_u: string, key: string) => { deletedBlobs.push(key) },
}))
vi.mock('./photo-queue', () => ({
  getPendingPhotoBlob: async () => holder.blob,
  deletePendingPhotoBlob: async (_u: string, key: string) => { deletedBlobs.push(key) },
}))

import { processPendingPhotoUploads, retryFailedPhotoUploads } from '@/lib/dexie/photo-sync'

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

function photoRow(): Promise<PendingPhotoUploadRow | undefined> {
  return db().pending_photo_uploads.get('ph1') as Promise<PendingPhotoUploadRow | undefined>
}

function setOnline(value: boolean): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: value } })
}

/** Minimal Supabase storage stub whose upload() returns the queued results in order. */
function makeStorage(results: { error: { message: string } | null }[]) {
  const attempts: string[] = []
  return {
    attempts,
    client: {
      storage: {
        from: () => ({
          upload: async (path: string) => {
            attempts.push(path)
            return results[attempts.length - 1] ?? { error: null }
          },
          getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }),
        }),
      },
    },
  }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-07-30T09:00:00.000Z'))
  deletedBlobs.length = 0
  holder.db = makeFakeDexieDb()
  holder.blob = new Blob(['x'])
  setOnline(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  await db().pending_photo_uploads.put({
    id: 'ph1',
    target_table: 'checklist_instance_items',
    target_id: 'item1',
    target_column: 'photo_storage_path',
    storage_path: 'turnover-1/item1.jpg',
    local_blob_key: 'blob1',
    mime_type: 'image/jpeg',
    retry_count: 0,
    created_at: '2026-07-30T08:00:00.000Z',
  })
  await db().checklist_instance_items.put({ id: 'item1', is_completed: 1 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('photo queue durability', () => {
  it('does not attempt or charge a retry while offline', async () => {
    setOnline(false)
    const storage = makeStorage([])

    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub, not a full SupabaseClient
      await processPendingPhotoUploads(storage.client as any, 'u1')
    }

    expect(storage.attempts).toHaveLength(0)
    const row = await photoRow()
    expect(row!.retry_count).toBe(0)
    expect(row!.failed).toBeUndefined()
    expect(deletedBlobs, 'the blob must survive — it is the only copy').toEqual([])
  })

  it('backs off between attempts instead of retrying on every tick', async () => {
    const storage = makeStorage(Array.from({ length: 10 }, () => ({ error: { message: 'server refused' } })))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    const client = storage.client as any

    await processPendingPhotoUploads(client, 'u1')
    expect(storage.attempts).toHaveLength(1)
    const afterFirst = await photoRow()
    expect(afterFirst!.retry_count).toBe(1)
    expect(afterFirst!.next_attempt_at!).toBeGreaterThan(Date.now())

    // A second tick inside the backoff window must not re-attempt.
    await processPendingPhotoUploads(client, 'u1')
    expect(storage.attempts).toHaveLength(1)

    vi.setSystemTime(afterFirst!.next_attempt_at! + 1)
    await processPendingPhotoUploads(client, 'u1')
    expect(storage.attempts).toHaveLength(2)
  })

  it('a transport failure never consumes the retry budget or dead-letters', async () => {
    const storage = makeStorage(Array.from({ length: 40 }, () => ({ error: { message: 'Failed to fetch' } })))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    const client = storage.client as any

    for (let i = 0; i < 20; i++) {
      await processPendingPhotoUploads(client, 'u1')
      vi.setSystemTime(Date.now() + 600_000)
    }

    const row = await photoRow()
    expect(row).toBeDefined()
    expect(row!.retry_count).toBe(0)
    expect(row!.failed).toBeUndefined()
    expect(row!.network_retry_count!).toBeGreaterThan(5)
    expect(deletedBlobs).toEqual([])
  })

  it('keeps a permanently-failed photo (and its blob) and marks it for the UI', async () => {
    const storage = makeStorage(Array.from({ length: 10 }, () => ({ error: { message: 'server refused' } })))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    const client = storage.client as any

    for (let i = 0; i < 6; i++) {
      await processPendingPhotoUploads(client, 'u1')
      vi.setSystemTime(Date.now() + 600_000)
    }

    const row = await photoRow()
    expect(row).toMatchObject({ retry_count: 5, failed: true })
    expect(row!.last_error).toBeTruthy()
    // The blob must still exist — "Retry" in the failed-sync banner has
    // nothing to upload otherwise.
    expect(deletedBlobs).toEqual([])
  })

  it('retryFailedPhotoUploads re-queues a dead-lettered photo and it can then succeed', async () => {
    const failing = makeStorage(Array.from({ length: 10 }, () => ({ error: { message: 'server refused' } })))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    const failingClient = failing.client as any
    for (let i = 0; i < 6; i++) {
      await processPendingPhotoUploads(failingClient, 'u1')
      vi.setSystemTime(Date.now() + 600_000)
    }
    expect((await photoRow())!.failed).toBe(true)

    const ok = makeStorage([{ error: null }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    await retryFailedPhotoUploads(ok.client as any, 'u1')
    await vi.advanceTimersByTimeAsync(0)

    expect(ok.attempts).toHaveLength(1)
    expect(await photoRow(), 'a successful retry removes the row').toBeUndefined()
    expect(deletedBlobs, 'and collects the blob').toEqual(['blob1'])
    // The uploaded path reached the local row and the outbox.
    expect(await db().checklist_instance_items.get('item1')).toMatchObject({
      photo_storage_path: 'turnover-1/item1.jpg',
    })
    expect(await db().mutations.toArray()).toHaveLength(1)
  })

  it('the queued mutation carries only photo_storage_path (B4c: no completed_at)', async () => {
    const ok = makeStorage([{ error: null }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    await processPendingPhotoUploads(ok.client as any, 'u1')

    const [mutation] = await db().mutations.toArray()
    expect(Object.keys((mutation as { payload: object }).payload)).toEqual(['photo_storage_path'])
  })
})
