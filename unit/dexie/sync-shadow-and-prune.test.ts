import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDexieDb, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/lib/dexie/schema', () => ({ getDexieDb: () => holder.db }))
vi.mock('../schema', () => ({ getDexieDb: () => holder.db }))
vi.mock('@/lib/dexie/photo-queue', () => ({
  deletePendingPhotoBlob: vi.fn(async () => {}),
}))

import { shadowPendingMutations } from '@/lib/dexie/sync/shadow'
import { pruneLocalCache, countPendingSyncWork } from '@/lib/dexie/prune'

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

const DAY = 86_400_000

beforeEach(() => {
  holder.db = makeFakeDexieDb()
})

describe('pending-mutation shadowing', () => {
  it('rebases a queued local write over the freshly-pulled server row', async () => {
    await db().mutations.add({
      table: 'inventory_counts', targetId: 'i1', op: 'PUT',
      payload: { current_quantity: 7 }, createdAt: '2026-07-30T00:00:00Z', retryCount: 0,
    failed: 0,
  })

    const [row] = await shadowPendingMutations('u1', 'inventory_counts', [
      { id: 'i1', current_quantity: 2, name: 'Towels' },
    ])

    // The server still says 2; the crew member's un-pushed count is 7 and
    // must not be reverted in front of them by a routine pull.
    expect(row).toEqual({ id: 'i1', current_quantity: 7, name: 'Towels' })
  })

  it('applies queued mutations in insertion order, so the newest value wins', async () => {
    for (const qty of [4, 9]) {
      await db().mutations.add({
        table: 'inventory_counts', targetId: 'i1', op: 'PUT',
        payload: { current_quantity: qty }, createdAt: '2026-07-30T00:00:00Z', retryCount: 0,
    failed: 0,
  })
    }
    const [row] = await shadowPendingMutations('u1', 'inventory_counts', [{ id: 'i1', current_quantity: 2 }])
    expect(row).toMatchObject({ current_quantity: 9 })
  })

  it('shadows dead-lettered mutations too — that write did not reach the server either', async () => {
    await db().mutations.add({
      table: 'turnovers', targetId: 't1', op: 'PATCH',
      payload: { status: 'completed' }, createdAt: '2026-07-30T00:00:00Z', retryCount: 5, failed: 1,
    })
    const [row] = await shadowPendingMutations('u1', 'turnovers', [{ id: 't1', status: 'in_progress' }])
    expect(row).toMatchObject({ status: 'completed' })
  })

  it('never injects payload keys that are not columns of the cached row', async () => {
    await db().mutations.add({
      table: 'property_assets', targetId: 'a1', op: 'PATCH',
      payload: { photo_url: 'https://x/y.jpg', scanRequest: { storagePath: 'p', mediaType: 'image/jpeg' } },
      createdAt: '2026-07-30T00:00:00Z', retryCount: 0,
    failed: 0,
  })
    const [row] = await shadowPendingMutations('u1', 'property_assets', [{ id: 'a1', photo_url: '' }])
    expect(row).toEqual({ id: 'a1', photo_url: 'https://x/y.jpg' })
    expect(row).not.toHaveProperty('scanRequest')
  })

  it('leaves rows with no queued mutation untouched', async () => {
    const rows = [{ id: 'i9', current_quantity: 2 }]
    expect(await shadowPendingMutations('u1', 'inventory_counts', rows)).toBe(rows)
  })
})

describe('local cache pruning', () => {
  it('drops reference rows for properties the crew member no longer has', async () => {
    await db().turnovers.put({ id: 't1', property_id: 'p-live', status: 'assigned' })
    for (const id of ['p-live', 'p-gone']) await db().properties.put({ id })
    await db().inventory_items.put({ id: 'i-live', property_id: 'p-live' })
    await db().inventory_items.put({ id: 'i-gone', property_id: 'p-gone' })
    await db().property_assets.put({ id: 'a-gone', property_id: 'p-gone' })

    await pruneLocalCache('u1')

    expect((await db().properties.toArray()).map((p) => p.id)).toEqual(['p-live'])
    expect((await db().inventory_items.toArray()).map((i) => i.id)).toEqual(['i-live'])
    expect(await db().property_assets.toArray()).toEqual([])
  })

  it('keeps live dead letters and only collects expired ones', async () => {
    const recent = new Date(Date.now() - 2 * DAY).toISOString()
    const ancient = new Date(Date.now() - 200 * DAY).toISOString()
    await db().mutations.add({ table: 'turnovers', targetId: 't1', op: 'PATCH', payload: {}, createdAt: recent, retryCount: 5, failed: 1 })
    await db().mutations.add({ table: 'turnovers', targetId: 't2', op: 'PATCH', payload: {}, createdAt: ancient, retryCount: 5, failed: 1 })
    await db().pending_photo_uploads.put({ id: 'ph1', created_at: ancient, failed: 1, local_blob_key: 'k1' })
    await db().pending_photo_uploads.put({ id: 'ph2', created_at: recent, failed: 1, local_blob_key: 'k2' })

    await pruneLocalCache('u1')

    const left = await db().mutations.toArray()
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ targetId: 't1' })
    expect((await db().pending_photo_uploads.toArray()).map((p) => p.id)).toEqual(['ph2'])
  })
})

describe('countPendingSyncWork', () => {
  it('counts only work still on its way, reporting dead letters separately', async () => {
    await db().mutations.add({ table: 'turnovers', targetId: 't1', op: 'PATCH', payload: {}, createdAt: '', retryCount: 0,
    failed: 0,
  })
    await db().mutations.add({ table: 'turnovers', targetId: 't2', op: 'PATCH', payload: {}, createdAt: '', retryCount: 5, failed: 1 })
    await db().pending_photo_uploads.put({ id: 'p1', created_at: '', local_blob_key: 'k' })

    expect(await countPendingSyncWork('u1')).toEqual({ pending: 2, deadLettered: 1 })
  })
})
