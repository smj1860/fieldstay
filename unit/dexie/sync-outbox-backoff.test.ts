import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

const holder = vi.hoisted(() => ({
  db:       null as unknown,
  supabase: null as unknown,
}))

vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  // Logout shutdown latch (lib/dexie/schema.ts) — never latched in these tests.
  isDexieShutdown: () => false,
}))

// SyncEngine captures createClient() at construction — delegate through the
// holder so each test can swap in its own queued fake supabase.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => (holder.supabase as ReturnType<typeof makeFakeSupabase>).from(table),
  }),
}))

import {
  SyncEngine,
  computeNextAttemptAt,
  CONSECUTIVE_FAILURE_CIRCUIT_BREAK,
} from '@/lib/dexie/syncService'

const NOW = Date.parse('2026-07-25T12:00:00.000Z')

function db(): FakeDexieDb { return holder.db as FakeDexieDb }
function supabaseCalls() { return (holder.supabase as ReturnType<typeof makeFakeSupabase>).calls }

// checklist_instance_items:PATCH is the simplest pure-supabase upload handler
// (update → eq → select) — no fetch()-routed side effects to stub.
async function seedMutation(overrides: Partial<MutationRow> = {}): Promise<number> {
  const id = await db().mutations.add({
    table:      'checklist_instance_items',
    targetId:   'item1',
    op:         'PATCH',
    payload:    { is_completed: 1 },
    createdAt:  new Date(NOW).toISOString(),
    retryCount: 0,
    ...overrides,
  })
  return id as number
}

async function mutationRow(id: number): Promise<MutationRow | undefined> {
  return (await db().mutations.get(id)) as MutationRow | undefined
}

const UPLOAD_OK   = { data: [{ id: 'item1' }], error: null }
const UPLOAD_FAIL = { error: { message: 'network down' } }

describe('computeNextAttemptAt — backoff delay math', () => {
  afterEach(() => vi.restoreAllMocks())

  it('grows 5s → 10s → 20s → 40s (jitter factor pinned to 1.0)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // factor = 0.5 + 0.5 = 1.0
    expect(computeNextAttemptAt(1, NOW)).toBe(NOW + 5_000)
    expect(computeNextAttemptAt(2, NOW)).toBe(NOW + 10_000)
    expect(computeNextAttemptAt(3, NOW)).toBe(NOW + 20_000)
    expect(computeNextAttemptAt(4, NOW)).toBe(NOW + 40_000)
  })

  it('caps the base delay at 5 minutes', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    // 2^6 * 5s = 320s > 300s cap
    expect(computeNextAttemptAt(7, NOW)).toBe(NOW + 300_000)
    expect(computeNextAttemptAt(20, NOW)).toBe(NOW + 300_000)
  })

  it('jitter scales each delay by 0.5–1.5x (bounds of the uniform factor)', () => {
    const random = vi.spyOn(Math, 'random')
    random.mockReturnValue(0) // factor 0.5
    expect(computeNextAttemptAt(1, NOW)).toBe(NOW + 2_500)
    random.mockReturnValue(0.999_999) // factor → just under 1.5
    expect(computeNextAttemptAt(1, NOW)).toBeLessThan(NOW + 7_500)
    expect(computeNextAttemptAt(1, NOW)).toBeGreaterThanOrEqual(NOW + 2_500)
  })

  it('stays inside [0.5x, 1.5x) of the base delay with real randomness', () => {
    for (let i = 0; i < 100; i++) {
      const delay = computeNextAttemptAt(2, 0) // base 10s
      expect(delay).toBeGreaterThanOrEqual(5_000)
      expect(delay).toBeLessThan(15_000)
    }
  })
})

describe('processOutbox — retry backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    holder.db = makeFakeDexieDb()
    holder.supabase = makeFakeSupabase({})
    // Failure paths log deliberately — keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('blocks the not-yet-due RECORD without stranding unrelated ones', async () => {
    // The ordering invariant is per-record, but it used to be enforced
    // globally: one mutation inside its backoff window stopped the entire
    // queue. On reconnect after an offline shift that is dozens of unrelated
    // writes waiting on one flaky record.
    const headId    = await seedMutation({ retryCount: 1, nextAttemptAt: NOW + 60_000 })
    const sameRecId = await seedMutation()                        // item1 again, due
    const otherId   = await seedMutation({ targetId: 'item2' })   // different record, due
    holder.supabase = makeFakeSupabase({
      checklist_instance_items: [UPLOAD_OK, UPLOAD_OK, UPLOAD_OK, UPLOAD_OK],
    })

    const engine = new SyncEngine('u1')
    await engine.processOutbox()

    // The backing-off record is untouched — including the LATER write to it,
    // which must never overtake the one that is waiting.
    expect(await mutationRow(headId)).toMatchObject({ retryCount: 1, nextAttemptAt: NOW + 60_000 })
    expect(await mutationRow(sameRecId)).toMatchObject({ retryCount: 0 })

    // An unrelated record drains.
    expect(
      await mutationRow(otherId),
      'a different record must not be held behind an unrelated backoff window',
    ).toBeUndefined()

    // One resume timer scheduled; a second stopped drain replaces it (single handle).
    expect(vi.getTimerCount()).toBe(1)
    await engine.processOutbox()
    expect(vi.getTimerCount()).toBe(1)

    // When the head comes due, the timer re-runs the drain and both flush in order.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await mutationRow(headId)).toBeUndefined()
    expect(await mutationRow(sameRecId)).toBeUndefined()
  })

  it('stands down entirely once several DISTINCT records fail in a row', async () => {
    // Per-record blocking alone would turn a server-side outage — where every
    // record fails — into N wasted requests per wave instead of one. Distinct
    // records failing back to back is evidence the problem is the server.
    for (const targetId of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await seedMutation({ targetId })
    }
    holder.supabase = makeFakeSupabase({
      checklist_instance_items: Array.from({ length: 10 }, () => ({
        error: { message: 'server exploded', code: 'XX000' },   // transient
      })),
    })

    await new SyncEngine('u1').processOutbox()

    const attempted = (await db().mutations.toArray() as unknown as MutationRow[])
      .filter((m) => m.retryCount > 0)
    expect(
      attempted,
      'the drain must stop probing a server that just rejected several unrelated records',
    ).toHaveLength(CONSECUTIVE_FAILURE_CIRCUIT_BREAK)
  })

  it('retries a due mutation and clears nextAttemptAt on success (row removed)', async () => {
    const id = await seedMutation({ retryCount: 2, nextAttemptAt: NOW - 1_000 })
    holder.supabase = makeFakeSupabase({ checklist_instance_items: [UPLOAD_OK] })

    await new SyncEngine('u1').processOutbox()

    expect(await mutationRow(id)).toBeUndefined()
    expect(supabaseCalls().filter((c) => c.method === 'update')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sets nextAttemptAt with backoff on push failure and resumes via the timer', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // jitter factor 1.0
    const id = await seedMutation()
    holder.supabase = makeFakeSupabase({ checklist_instance_items: [UPLOAD_FAIL, UPLOAD_OK] })

    await new SyncEngine('u1').processOutbox()

    // First failure: retryCount 1, due again in 5s (base delay, factor 1.0).
    expect(await mutationRow(id)).toMatchObject({ retryCount: 1, nextAttemptAt: NOW + 5_000 })
    expect(vi.getTimerCount()).toBe(1)

    // The scheduled retry fires once due, succeeds, and removes the row.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await mutationRow(id)).toBeUndefined()
  })

  it('keeps the permanent-failure (dead-letter) path unchanged', async () => {
    const id = await seedMutation({ retryCount: 4 })
    holder.supabase = makeFakeSupabase({ checklist_instance_items: [UPLOAD_FAIL, UPLOAD_OK] })

    const engine = new SyncEngine('u1')
    await engine.processOutbox()

    // Fifth failure dead-letters: row kept, marked failed, no backoff window.
    const row = await mutationRow(id)
    expect(row).toMatchObject({ retryCount: 5, failed: 1 })
    expect(row?.nextAttemptAt).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    // Dead-lettered rows are excluded from later drains, not retried forever.
    await engine.processOutbox()
    expect(supabaseCalls().filter((c) => c.method === 'update')).toHaveLength(1)
    expect(await mutationRow(id)).toMatchObject({ retryCount: 5, failed: 1 })
  })
})
