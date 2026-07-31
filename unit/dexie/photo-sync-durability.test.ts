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

// turnover-photos is a PRIVATE bucket whose storage RLS policies match on the
// FIRST path segment (lib/storage/object-path.ts), so every queued path is
// `${org_id}/…`. The fixtures below use that shape deliberately — a path
// without it is the LEGACY shape, exercised on its own further down.
const ORG_ID = '11111111-1111-4111-8111-111111111111'
const PHOTO_PATH = `${ORG_ID}/turnover-1/item1.jpg`

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
    storage_path: PHOTO_PATH,
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
      photo_storage_path: PHOTO_PATH,
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

  // ── Legacy (pre-org-prefix) paths ────────────────────────────────────────
  // turnover-photos became private mid-flight and its policies key off the
  // first path segment. A photo queued on-device BEFORE that change carries a
  // path no policy can see, so it can never upload as-queued.

  it('repairs a legacy non-org-prefixed path from the local cache and uploads it', async () => {
    await db().pending_photo_uploads.update('ph1', { storage_path: 'turnover-1/item1.jpg' })
    await db().checklist_instance_items.put({ id: 'item1', is_completed: 1, instance_id: 'inst1' })
    await db().checklist_instances.put({ id: 'inst1', org_id: ORG_ID })

    const ok = makeStorage([{ error: null }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    await processPendingPhotoUploads(ok.client as any, 'u1')

    expect(ok.attempts, 'uploaded under the org-scoped key the policies can see').toEqual([PHOTO_PATH])
    expect(await photoRow()).toBeUndefined()
    expect(await db().checklist_instance_items.get('item1')).toMatchObject({
      photo_storage_path: PHOTO_PATH,
    })
  })

  it('an unresolvable org id backs off and eventually dead-letters — never a silent forever-skip', async () => {
    // Legacy path AND no local row to recover the org id from: the drain can
    // build no policy-visible path at all. This used to `continue` on every
    // tick, so the photo was never attempted, never marked failed, and never
    // shown anywhere — invisible forever with its blob still on the device.
    await db().pending_photo_uploads.update('ph1', { storage_path: 'turnover-1/item1.jpg' })

    const storage = makeStorage([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    const client = storage.client as any

    await processPendingPhotoUploads(client, 'u1')
    const afterFirst = await photoRow()
    expect(storage.attempts, 'no upload is possible, so none is attempted').toEqual([])
    expect(afterFirst!.retry_count, 'the attempt is counted, not skipped').toBe(1)
    expect(afterFirst!.next_attempt_at!, 'and it backs off rather than spinning every tick')
      .toBeGreaterThan(Date.now())

    for (let i = 0; i < 6; i++) {
      await processPendingPhotoUploads(client, 'u1')
      vi.setSystemTime(Date.now() + 600_000)
    }

    const row = await photoRow()
    expect(row, 'the row survives — it is the only record of the photo').toBeDefined()
    expect(row).toMatchObject({ retry_count: 5, failed: true })
    expect(row!.last_error, 'and says why, on the failed-sync surface').toBeTruthy()
    expect(deletedBlobs, 'the blob is kept so "Retry" has something to upload').toEqual([])
  })

  it('a dead-lettered unresolvable photo succeeds once its org row finally syncs', async () => {
    await db().pending_photo_uploads.update('ph1', { storage_path: 'turnover-1/item1.jpg' })

    const stuck = makeStorage([])
    for (let i = 0; i < 7; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
      await processPendingPhotoUploads(stuck.client as any, 'u1')
      vi.setSystemTime(Date.now() + 600_000)
    }
    expect((await photoRow())!.failed).toBe(true)

    // The safety poll lands the missing rows.
    await db().checklist_instance_items.put({ id: 'item1', is_completed: 1, instance_id: 'inst1' })
    await db().checklist_instances.put({ id: 'inst1', org_id: ORG_ID })

    const ok = makeStorage([{ error: null }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow storage stub
    await retryFailedPhotoUploads(ok.client as any, 'u1')
    await vi.advanceTimersByTimeAsync(0)

    expect(ok.attempts).toEqual([PHOTO_PATH])
    expect(await photoRow()).toBeUndefined()
    expect(deletedBlobs).toEqual(['blob1'])
  })
})
