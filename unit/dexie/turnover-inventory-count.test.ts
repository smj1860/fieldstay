// The crew turnover inventory count, after it stopped being a per-item
// write-through to inventory_items.current_quantity.
//
// Two defects it replaces, both of which corrupt the data the below-par
// restock automation buys stock from:
//
//  1. The count input was PRE-FILLED with the item's last known
//     current_quantity, so a fresh count had to be typed over the previous
//     one. A crew member who glanced at a shelf and moved on submitted the
//     old number as a new measurement — and `previous_quantity` then equalled
//     `counted_qty` not because stock hadn't moved but because nobody touched
//     the field. Anchoring, on a number that drives purchasing.
//
//  2. Writing current_quantity per item produced no inventory_counts record,
//     no previous-vs-counted diff, and never fired inventory/count-submitted.
//     Neither crew inventory surface reached the restock pipeline at all —
//     only counts the PM hand-entered did.
//
// The rule that falls out of both: an absent key means NOT COUNTED and is
// never submitted; 0 means counted-and-empty and always is.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/lib/dexie/schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dexie/schema')>()),
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({}) }) }))

import {
  loadTurnoverInventoryCounts,
  saveTurnoverInventoryCounts,
  submitTurnoverInventoryCounts,
} from '@/lib/dexie/helpers'

const USER = 'u1'
const TURNOVER_A = 'turnover-a'
const TURNOVER_B = 'turnover-b'
const PROPERTY = 'prop-1'

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

async function outbox(): Promise<MutationRow[]> {
  return (await db().mutations.toArray()) as unknown as MutationRow[]
}

beforeEach(() => {
  holder.db = makeFakeDexieDb()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('staged counts are scoped to the turnover, not the property', () => {
  it('does not leak a partial count into another turnover at the same property', async () => {
    await saveTurnoverInventoryCounts(USER, TURNOVER_A, { 'item-1': 4 })

    expect(
      await loadTurnoverInventoryCounts(USER, TURNOVER_B),
      'a count abandoned on one turnover must not pre-populate the next one',
    ).toEqual({})
    expect(await loadTurnoverInventoryCounts(USER, TURNOVER_A)).toEqual({ 'item-1': 4 })
  })

  it('survives a reload — the per-item write-through was the old durability', async () => {
    await saveTurnoverInventoryCounts(USER, TURNOVER_A, { 'item-1': 2, 'item-2': 0 })
    expect(await loadTurnoverInventoryCounts(USER, TURNOVER_A)).toEqual({ 'item-1': 2, 'item-2': 0 })
  })

  it('starts fresh rather than throwing on a corrupt staging row', async () => {
    await db().sync_meta.put({ key: `inventory_count:turnover:${TURNOVER_A}`, value: '{not json' })
    expect(await loadTurnoverInventoryCounts(USER, TURNOVER_A)).toEqual({})
  })
})

describe('submission', () => {
  it('queues ONE count carrying only the items actually counted', async () => {
    // item-3 was never touched: it must not be submitted at all. Submitting it
    // as a zero would order a full restock of stock nobody looked at.
    const counted = { 'item-1': 7, 'item-2': 0 }
    await saveTurnoverInventoryCounts(USER, TURNOVER_A, counted)
    await submitTurnoverInventoryCounts(USER, PROPERTY, TURNOVER_A, counted)

    const queued = await outbox()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.table).toBe('inventory_counts')
    expect(queued[0]!.op).toBe('PUT')
    expect(queued[0]!.payload).toEqual({ property_id: PROPERTY, counts: counted })
    expect(
      Object.keys(queued[0]!.payload.counts as object),
      'an uncounted item must be absent, not zero',
    ).toEqual(['item-1', 'item-2'])
  })

  it('keeps a counted zero — the signal most worth reaching the restock cart', async () => {
    await submitTurnoverInventoryCounts(USER, PROPERTY, TURNOVER_A, { 'item-1': 0 })
    const [queued] = await outbox()
    expect((queued!.payload.counts as Record<string, number>)['item-1']).toBe(0)
  })

  it('uses a fresh client-generated id per submission, for PK idempotency', async () => {
    await submitTurnoverInventoryCounts(USER, PROPERTY, TURNOVER_A, { 'item-1': 1 })
    await submitTurnoverInventoryCounts(USER, PROPERTY, TURNOVER_B, { 'item-1': 1 })

    const ids = (await outbox()).map((m) => m.targetId)
    expect(new Set(ids).size, 'the route uses targetId as the inventory_counts PK').toBe(2)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    }
  })

  it('clears the staging row in the same transaction as the queued count', async () => {
    await saveTurnoverInventoryCounts(USER, TURNOVER_A, { 'item-1': 3 })
    await submitTurnoverInventoryCounts(USER, PROPERTY, TURNOVER_A, { 'item-1': 3 })

    expect(
      await loadTurnoverInventoryCounts(USER, TURNOVER_A),
      'a staged count left behind after submit is resubmitted as a duplicate under a new id',
    ).toEqual({})
    expect(await outbox()).toHaveLength(1)
  })
})
