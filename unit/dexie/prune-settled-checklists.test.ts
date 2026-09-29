import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeDexieDb, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

import { pruneSettledChecklistItems } from '@/lib/dexie/prune'

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

// The cursor is the pivot for every case here: `completed_at < cursor` is the
// condition "the next delta pull will not return these rows".
const CURSOR   = '2026-03-10T00:00:00.000Z'
const SETTLED  = '2026-03-01T00:00:00.000Z'   // well before the cursor
const JUST_NOW = '2026-03-10T00:00:05.000Z'   // after it — inside the overlap

const ITEMS_PER = 3

async function seed(opts: {
  cursor?: string | null
  instances: { id: string; turnover_id: string; completed_at: string | null }[]
}) {
  if (opts.cursor !== null) {
    await db().sync_meta.put({ key: 'cursor:checklist_items', value: opts.cursor ?? CURSOR })
  }
  await db().checklist_instances.bulkPut(
    opts.instances.map((i) => ({ ...i, org_id: 'org1', status: 'active' })),
  )
  const items = opts.instances.flatMap((i) =>
    Array.from({ length: ITEMS_PER }, (_, n) => ({
      id: `${i.id}_item${n}`, instance_id: i.id, turnover_id: i.turnover_id, task: `t${n}`,
    })),
  )
  await db().checklist_instance_items.bulkPut(items)
}

async function remainingItemIds(): Promise<string[]> {
  return (await db().checklist_instance_items.toArray()).map((i) => (i as { id: string }).id).sort()
}

describe('pruneSettledChecklistItems', () => {
  beforeEach(() => { holder.db = makeFakeDexieDb() })

  it('drops items for a checklist that settled before the cursor', async () => {
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: SETTLED }] })

    expect(await pruneSettledChecklistItems('u1')).toBe(ITEMS_PER)
    expect(await remainingItemIds()).toEqual([])
    // The instance row stays: it is the only local record of completed_at
    // (items drop updated_at in normalization), and the turnover row staying
    // cached is what stops partitionByKnown re-pulling the whole checklist.
    expect(await db().checklist_instances.get('ci1')).toBeDefined()
  })

  it('HOLE 3, closed: a JUST-completed checklist is retained, not purged', async () => {
    // completed_at is newer than the cursor, so the next delta pull WOULD
    // return these rows. Purging here is what produced the purge/re-pull loop
    // characterized in crew-cache-retention-behaviour.test.ts.
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: JUST_NOW }] })

    expect(await pruneSettledChecklistItems('u1')).toBe(0)
    expect(await remainingItemIds()).toHaveLength(ITEMS_PER)
  })

  it('never purges an unfinished checklist', async () => {
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: null }] })

    expect(await pruneSettledChecklistItems('u1')).toBe(0)
    expect(await remainingItemIds()).toHaveLength(ITEMS_PER)
  })

  it('is a no-op with no cursor — the next pull would be a full one', async () => {
    await seed({ cursor: null, instances: [{ id: 'ci1', turnover_id: 't1', completed_at: SETTLED }] })

    expect(await pruneSettledChecklistItems('u1')).toBe(0)
    expect(await remainingItemIds()).toHaveLength(ITEMS_PER)
  })

  it('purges only the settled checklists, leaving the rest untouched', async () => {
    await seed({ instances: [
      { id: 'ci1', turnover_id: 't1', completed_at: SETTLED },
      { id: 'ci2', turnover_id: 't2', completed_at: JUST_NOW },
      { id: 'ci3', turnover_id: 't3', completed_at: null },
    ] })

    expect(await pruneSettledChecklistItems('u1')).toBe(ITEMS_PER)
    const left = await remainingItemIds()
    expect(left.filter((id) => id.startsWith('ci1'))).toEqual([])
    expect(left.filter((id) => id.startsWith('ci2'))).toHaveLength(ITEMS_PER)
    expect(left.filter((id) => id.startsWith('ci3'))).toHaveLength(ITEMS_PER)
  })

  // ── The retain guard ──────────────────────────────────────────────────────
  // Each of these seeds work in a DIFFERENT state, because a mutation that has
  // not reached the server takes more than one shape and only some of them set
  // `failed`. A guard that only looked at pending rows would retain the cache
  // for the writes that are fine and shed it for the ones that are not.

  it('retains a settled checklist with a QUEUED PHOTO on one of its items', async () => {
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: SETTLED }] })
    await db().pending_photo_uploads.put({
      id: 'ph1', target_table: 'checklist_instance_items', target_id: 'ci1_item1',
      target_column: 'photo_storage_path', storage_path: 'org1/x.jpg',
      local_blob_key: 'b1', mime_type: 'image/jpeg', retry_count: 0,
      created_at: SETTLED,
    })

    // photo-sync resolves the upload's org prefix through this exact item row
    // (item -> instance -> org_id). Deleting it makes that resolution return
    // null, which dead-letters the photo: work silently thrown away.
    expect(await pruneSettledChecklistItems('u1')).toBe(0)
    expect(await remainingItemIds()).toHaveLength(ITEMS_PER)
  })

  it('retains a settled checklist with a DEAD-LETTERED photo', async () => {
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: SETTLED }] })
    await db().pending_photo_uploads.put({
      id: 'ph1', target_table: 'checklist_instance_items', target_id: 'ci1_item2',
      target_column: 'photo_storage_path', storage_path: 'org1/x.jpg',
      local_blob_key: 'b1', mime_type: 'image/jpeg', retry_count: 5,
      created_at: SETTLED, failed: 1,
    })

    expect(await pruneSettledChecklistItems('u1')).toBe(0)
  })

  it('retains a settled checklist with a queued ITEM mutation', async () => {
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: SETTLED }] })
    await db().mutations.add({
      table: 'checklist_instance_items', targetId: 'ci1_item0', op: 'PATCH',
      payload: { is_completed: true }, createdAt: SETTLED, retryCount: 0,
    })

    expect(await pruneSettledChecklistItems('u1')).toBe(0)
  })

  it('retains a settled checklist with a queued TURNOVER mutation', async () => {
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: SETTLED }] })
    await db().mutations.add({
      table: 'turnovers', targetId: 't1', op: 'PATCH',
      payload: { status: 'completed' }, createdAt: SETTLED, retryCount: 0,
    })

    expect(await pruneSettledChecklistItems('u1')).toBe(0)
  })

  it('retains a settled checklist with a queued INSTANCE mutation', async () => {
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: SETTLED }] })
    await db().mutations.add({
      table: 'checklist_instances', targetId: 'ci1', op: 'PATCH',
      payload: {}, createdAt: SETTLED, retryCount: 0,
    })

    expect(await pruneSettledChecklistItems('u1')).toBe(0)
  })

  it('retains the busy checklist ENTIRELY while purging its settled neighbour', async () => {
    await seed({ instances: [
      { id: 'ci1', turnover_id: 't1', completed_at: SETTLED },
      { id: 'ci2', turnover_id: 't2', completed_at: SETTLED },
    ] })
    await db().pending_photo_uploads.put({
      id: 'ph1', target_table: 'checklist_instance_items', target_id: 'ci2_item1',
      target_column: 'photo_storage_path', storage_path: 'org1/x.jpg',
      local_blob_key: 'b1', mime_type: 'image/jpeg', retry_count: 0, created_at: SETTLED,
    })

    expect(await pruneSettledChecklistItems('u1')).toBe(ITEMS_PER)
    // All THREE of ci2's items survive, not just the one carrying the photo:
    // the org-prefix walk needs the item row, and a half-shed checklist is a
    // shape nothing else in the sync layer expects.
    const left = await remainingItemIds()
    expect(left).toEqual(['ci2_item0', 'ci2_item1', 'ci2_item2'])
  })

  it('is idempotent — a second run removes nothing more', async () => {
    await seed({ instances: [{ id: 'ci1', turnover_id: 't1', completed_at: SETTLED }] })

    expect(await pruneSettledChecklistItems('u1')).toBe(ITEMS_PER)
    expect(await pruneSettledChecklistItems('u1')).toBe(0)
  })
})
