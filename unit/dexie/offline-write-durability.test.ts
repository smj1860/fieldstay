// The 2026-08-04 offline-sync audit's data-loss set, run against real
// (fake-indexeddb) IndexedDB rather than the in-memory double used elsewhere
// in this directory — every property here is about what actually survives on
// the device, which a Map cannot model.
//
//  F1 — the optimistic local write and its outbox row were two separate
//       IndexedDB transactions. A PWA reclaimed between them (iOS
//       backgrounding, quota, a closed tab) left the cache updated with
//       nothing queued to send it: the crew member saw their tick as saved
//       forever, the server never heard about it, the failed-sync banner had
//       no row to show, and no delta pull would correct it either because the
//       server row's updated_at never changed.
//
//  F2 — holdBackSuccessors() only ever saw successors that existed AT the
//       moment of dead-lettering, which is the less likely half of the
//       problem: the corrective edit is normally made AFTER the failure.
//       Tick → dead-letter → un-tick (pushes fine) → "Retry all" replays the
//       stale tick on top and the server flips back.
//
//  F3 — logout with a second tab open. The shutdown latch is per-DOCUMENT
//       module state but IndexedDB is per-ORIGIN, so the sibling tab kept its
//       connection open, `Dexie.delete` blocked on it indefinitely, and the
//       await before signOut()/redirect never resolved. Logout silently did
//       nothing and the crew cache stayed on a shared device.
//
//  F4 — discarding a dead letter removed the shadow overlay but not the
//       cursor that had advanced past the server row it was masking, pinning
//       the cache to a value the server never accepted, permanently.
//
//  F5 — photo blobs live in a SEPARATE IndexedDB from their tracking rows, so
//       the two can never be written atomically; nothing ever collected a blob
//       whose row never landed.

import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ from: () => ({ update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) }),
}))

import {
  getDexieDb,
  closeDexieDb,
  resumeDexieDb,
  isDexieShutdown,
  listenForRemoteShutdown,
  type MutationRow,
} from '@/lib/dexie/schema'
import { enqueueMutationTx, HELD_BACK_REASON } from '@/lib/dexie/syncService'
import { updateChecklistItem, discardFailedMutation } from '@/lib/dexie/helpers'
import { savePendingPhotoBlob, listPendingPhotoBlobKeys, getPendingPhotoBlob } from '@/lib/dexie/photo-queue'
import { pruneOrphanPhotoBlobs } from '@/lib/dexie/prune'

const USER = '22222222-2222-4222-8222-222222222222'
const ITEM = 'item-1'

async function seedItem(): Promise<void> {
  await getDexieDb(USER).checklist_instance_items.put({
    id: ITEM, instance_id: 'inst-1', turnover_id: 't-1', section_name: 'Kitchen',
    task: 'Wipe counters', is_completed: 0, completed_at: null, completed_by_crew_id: '',
    requires_photo: 0, photo_reason: '', photo_storage_path: null, crew_notes: '',
    sort_order: 1, is_section_final_item: 0, asset_discovery_type: '',
  })
}

async function mutations(): Promise<MutationRow[]> {
  return getDexieDb(USER).mutations.orderBy('id').toArray()
}

beforeEach(() => {
  resumeDexieDb(USER)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await closeDexieDb()
  resumeDexieDb(USER)
  vi.restoreAllMocks()
})

describe('F1 — the local write and its outbox row commit atomically', () => {
  it('lands both on success', async () => {
    await seedItem()
    await updateChecklistItem(USER, ITEM, { isCompleted: true }, 'crew-1')

    const item = await getDexieDb(USER).checklist_instance_items.get(ITEM)
    expect(item?.is_completed, 'the cache reflects the tick immediately').toBe(1)

    const queued = await mutations()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ table: 'checklist_instance_items', targetId: ITEM, op: 'PATCH' })
  })

  it('rolls the cache write BACK when the outbox row cannot be written', async () => {
    await seedItem()
    const db = getDexieDb(USER)

    // Stand in for the real failure mode — quota exhaustion, or the app being
    // killed before the second transaction commits. As two transactions the
    // cache write had already committed and there was nothing left to undo it.
    const boom = () => { throw new Error('simulated outbox write failure') }
    db.mutations.hook('creating', boom)

    await expect(updateChecklistItem(USER, ITEM, { isCompleted: true }, 'crew-1')).rejects.toThrow()
    db.mutations.hook('creating').unsubscribe(boom)

    const item = await db.checklist_instance_items.get(ITEM)
    expect(
      item?.is_completed,
      'a tick with no outbox row is silent data loss — the crew member sees it saved, the server never hears about it',
    ).toBe(0)
    expect(await mutations()).toHaveLength(0)
  })
})

describe('F2 — a record with a dead letter is frozen', () => {
  it('queues a LATER write to the same record already held back', async () => {
    const db = getDexieDb(USER)

    // The tick dead-lettered on a previous run; no successors existed then, so
    // holdBackSuccessors() had nothing to hold.
    await db.mutations.add({
      table: 'checklist_instance_items', targetId: ITEM, op: 'PATCH',
      payload: { is_completed: 1 }, createdAt: new Date().toISOString(),
      retryCount: 5, failed: 1, lastError: 'Server rejected the request (500)',
    })

    // The crew member now un-ticks it. Previously this queued clean, drained,
    // and left the dead letter behind to be replayed on top by "Retry all".
    await db.transaction('rw', db.mutations, () =>
      enqueueMutationTx(db, 'checklist_instance_items', ITEM, 'PATCH', { is_completed: 0 }),
    )

    const [, untick] = await mutations()
    expect(
      untick?.failed,
      'a write queued behind a dead letter must not drain ahead of it — otherwise Retry all replays the stale value on top',
    ).toBe(1)
    expect(untick?.lastError).toBe(HELD_BACK_REASON)
  })

  it('does not freeze a different record', async () => {
    const db = getDexieDb(USER)
    await db.mutations.add({
      table: 'checklist_instance_items', targetId: ITEM, op: 'PATCH',
      payload: { is_completed: 1 }, createdAt: new Date().toISOString(),
      retryCount: 5, failed: 1,
    })

    await db.transaction('rw', db.mutations, () =>
      enqueueMutationTx(db, 'checklist_instance_items', 'item-2', 'PATCH', { is_completed: 1 }),
    )

    const other = (await mutations()).find((m) => m.targetId === 'item-2')
    expect(other?.failed, 'an unrelated record must keep draining').toBeUndefined()
  })

  it('does not freeze the same targetId on a different table', async () => {
    const db = getDexieDb(USER)
    await db.mutations.add({
      table: 'turnovers', targetId: 'shared-id', op: 'PATCH',
      payload: { status: 'completed' }, createdAt: new Date().toISOString(),
      retryCount: 5, failed: 1,
    })

    await db.transaction('rw', db.mutations, () =>
      enqueueMutationTx(db, 'checklist_instances', 'shared-id', 'PATCH', { completed_at: null }),
    )

    const other = (await mutations()).find((m) => m.table === 'checklist_instances')
    expect(other?.failed).toBeUndefined()
  })
})

describe('F4 — abandoning a dead letter rewinds the cursor masking the server row', () => {
  it('clears the cursor for the discarded mutation\'s table', async () => {
    const db = getDexieDb(USER)
    await db.sync_meta.put({ key: 'cursor:checklist_items', value: '2026-08-04T00:00:00.000Z' })
    await db.sync_meta.put({ key: 'cursor:work_orders',     value: '2026-08-04T00:00:00.000Z' })

    const id = await db.mutations.add({
      table: 'checklist_instance_items', targetId: ITEM, op: 'PATCH',
      payload: { is_completed: 1 }, createdAt: new Date().toISOString(),
      retryCount: 5, failed: 1,
    })

    await discardFailedMutation(USER, id as number)

    expect(
      await db.sync_meta.get('cursor:checklist_items'),
      'without this the delta filter skips that row forever and the cache keeps a value the server never accepted',
    ).toBeUndefined()
    expect(
      await db.sync_meta.get('cursor:work_orders'),
      'only the affected table\'s cursor is rewound — a blanket reset would re-download everything',
    ).toBeDefined()
  })
})

describe('F5 — orphaned photo blobs are collected', () => {
  it('collects a blob no tracking row references, but only after two sweeps', async () => {
    await savePendingPhotoBlob(USER, 'orphan-key', new Blob(['bytes']))
    await savePendingPhotoBlob(USER, 'referenced-key', new Blob(['bytes']))
    await getDexieDb(USER).pending_photo_uploads.add({
      id: 'row-1', target_table: 'checklist_instance_items', target_id: ITEM,
      target_column: 'photo_storage_path', storage_path: 'org/x.jpg',
      local_blob_key: 'referenced-key', mime_type: 'image/jpeg', retry_count: 0,
      created_at: new Date().toISOString(),
    })

    // First sweep only nominates — a blob whose row is still mid-enqueue must
    // not be destroyed out from under it.
    await pruneOrphanPhotoBlobs(USER)
    expect(await getPendingPhotoBlob(USER, 'orphan-key')).not.toBeNull()

    await pruneOrphanPhotoBlobs(USER)
    expect(
      await getPendingPhotoBlob(USER, 'orphan-key'),
      'a blob nothing references is megabytes of dead weight pushing the origin toward eviction',
    ).toBeNull()
    expect(
      await getPendingPhotoBlob(USER, 'referenced-key'),
      'a blob a queued row still points at must survive — Retry needs it',
    ).not.toBeNull()
  })

  it('never nominates a blob that is still referenced', async () => {
    await savePendingPhotoBlob(USER, 'live-key', new Blob(['bytes']))
    await getDexieDb(USER).pending_photo_uploads.add({
      id: 'row-2', target_table: 'checklist_instance_items', target_id: ITEM,
      target_column: 'photo_storage_path', storage_path: 'org/y.jpg',
      local_blob_key: 'live-key', mime_type: 'image/jpeg', retry_count: 0,
      created_at: new Date().toISOString(),
    })

    await pruneOrphanPhotoBlobs(USER)
    await pruneOrphanPhotoBlobs(USER)
    await pruneOrphanPhotoBlobs(USER)

    expect(await listPendingPhotoBlobKeys(USER)).toContain('live-key')
  })
})

describe('F3 — logout is not blocked by a sibling tab', () => {
  it('resolves rather than hanging while another connection holds the database open', async () => {
    await seedItem()
    const dbName = getDexieDb(USER).name

    // Stand in for a second crew tab: a raw connection this document does not
    // own, exactly what makes deleteDatabase fire `blocked` and wait.
    const sibling = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName)
      req.onsuccess = () => resolve(req.result)
      req.onerror   = () => reject(req.error)
    })

    try {
      // The bug was not a slow logout — it was one that never completed, so
      // supabase.auth.signOut() and the redirect after it never ran at all.
      await closeDexieDb()
      expect(
        isDexieShutdown(USER),
        'the latch must hold even when the delete itself could not complete',
      ).toBe(true)
    } finally {
      sibling.close()
    }
  }, 15_000)

  it('a broadcast from another tab latches this document and notifies the UI', async () => {
    getDexieDb(USER)
    const onShutdown = vi.fn()
    const stop = listenForRemoteShutdown(USER, onShutdown)

    const channel = new BroadcastChannel('fieldstay-crew-logout')
    channel.postMessage({ type: 'shutdown', userId: USER })
    // BroadcastChannel delivery is a macrotask.
    await new Promise((resolve) => setTimeout(resolve, 10))
    channel.close()
    stop()

    expect(
      isDexieShutdown(USER),
      'a sibling tab that keeps draining re-creates the database the logging-out tab just wiped',
    ).toBe(true)
    expect(onShutdown, 'and the tab must leave the crew surface, not keep rendering it').toHaveBeenCalled()
  })

  it('ignores a broadcast for a different user', async () => {
    getDexieDb(USER)
    const onShutdown = vi.fn()
    const stop = listenForRemoteShutdown(USER, onShutdown)

    const channel = new BroadcastChannel('fieldstay-crew-logout')
    channel.postMessage({ type: 'shutdown', userId: 'someone-else' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    channel.close()
    stop()

    expect(isDexieShutdown(USER)).toBe(false)
    expect(onShutdown).not.toHaveBeenCalled()
  })
})
