// 2026-08-04 offline-sync audit, part 2 — the scheduling and versioning
// properties of the outbox drain.
//
//  F8  — a drain works from a snapshot taken before its loop, so a mutation
//        queued while one is in flight is invisible to it. enqueueMutation's
//        own kick then landed on the `isProcessing` guard and was DROPPED, so
//        that row waited for the crew shell's next 30 s tick — during the
//        reconnect window, which is exactly when a crew member is most likely
//        to still be working. Worse at logout, where the bounded final flush
//        could report "clean" for a row it had never attempted.
//
//  F10 — an outbox row can outlive the release that queued it (a device
//        offline across a deploy). A (table, op) this build has no handler for
//        threw a bare Error, which classifies as TRANSIENT: five pointless
//        round trips, then a dead letter whose user-facing text was a
//        developer string naming the table and op.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

const holder = vi.hoisted(() => ({
  db:       null as unknown,
  supabase: null as unknown,
  /** Resolves the in-flight upload on demand, so a second enqueue can be
   *  landed while the drain is genuinely mid-await. */
  gate:     null as null | { promise: Promise<unknown>; release: () => void; started: Promise<void> },
}))

vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain = (holder.supabase as ReturnType<typeof makeFakeSupabase>).from(table)
      if (!holder.gate) return chain
      const gate = holder.gate
      // Wrap only the terminal select() so the whole chain still records calls.
      const inner = chain.select
      chain.select = (...args: unknown[]) => {
        const result = inner(...args)
        return { then: (res: (v: unknown) => unknown) => gate.promise.then(() => result).then(res) }
      }
      return chain
    },
  }),
}))

import { SyncEngine, OUTBOX_PAYLOAD_VERSION } from '@/lib/dexie/syncService'
import { classifyUploadFailure, UploadDataError } from '@/lib/dexie/net'

function db(): FakeDexieDb { return holder.db as FakeDexieDb }
const UPLOAD_OK = { data: [{ id: 'x' }], error: null }

function setOnline(value: boolean): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: value } })
}

async function seed(overrides: Partial<MutationRow> = {}): Promise<number> {
  return await db().mutations.add({
    table:      'inventory_items',
    targetId:   'item1',
    op:         'PATCH',
    payload:    { current_quantity: 3 },
    createdAt:  new Date().toISOString(),
    retryCount: 0,
    ...overrides,
  }) as number
}

beforeEach(() => {
  holder.db = makeFakeDexieDb()
  holder.gate = null
  setOnline(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('F8 — a mutation queued mid-drain is not stranded until the next tick', () => {
  it('re-drains once the in-flight pass settles instead of dropping the wake-up', async () => {
    holder.supabase = makeFakeSupabase({
      inventory_items: [UPLOAD_OK, UPLOAD_OK, UPLOAD_OK],
    })
    await seed({ targetId: 'first' })

    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    holder.gate = { promise, release, started: Promise.resolve() }

    const engine = new SyncEngine('u1')
    const firstPass = engine.processOutbox()

    // Land a new mutation while the first push is genuinely in flight, and
    // ring the bell the same way enqueueMutation() does.
    await seed({ targetId: 'second' })
    await engine.processOutbox()   // swallowed by isProcessing — must be REMEMBERED

    holder.gate = null
    release()
    await firstPass

    expect(
      await db().mutations.toArray(),
      'the row queued mid-drain must be pushed by the same pass, not left for the 30 s interval',
    ).toHaveLength(0)
  })

  it('does not loop when nothing new was queued', async () => {
    holder.supabase = makeFakeSupabase({ inventory_items: [UPLOAD_OK] })
    await seed()

    const engine = new SyncEngine('u1')
    await engine.processOutbox()

    // One push, one drain — the re-drain loop must be driven by an actual
    // request, not spin on its own.
    const updates = (holder.supabase as ReturnType<typeof makeFakeSupabase>).calls
      .filter((c) => c.method === 'update')
    expect(updates).toHaveLength(1)
  })
})

describe('F10 — payload versioning and unknown handlers', () => {
  it('stamps the current payload version on every newly queued mutation', async () => {
    const { enqueueMutationTx } = await import('@/lib/dexie/syncService')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake db, not a real FieldStayDexie
    await enqueueMutationTx(db() as any, 'inventory_items', 'item1', 'PATCH', { current_quantity: 1 })

    const [row] = await db().mutations.toArray() as unknown as MutationRow[]
    expect(
      row!.payloadVersion,
      'without a version stamp a payload queued before a deploy replays blind against the new handler',
    ).toBe(OUTBOX_PAYLOAD_VERSION)
  })

  it('dead-letters an unhandled (table, op) immediately rather than burning five retries', async () => {
    holder.supabase = makeFakeSupabase({})
    // 'DELETE' has no entry in UPLOAD_HANDLERS — the shape of a row queued by
    // a release that supported an operation this build no longer does.
    const id = await seed({ op: 'DELETE' })

    await new SyncEngine('u1').processOutbox()

    const row = await db().mutations.get(id) as MutationRow | undefined
    expect(row?.failed, 'it can never succeed on replay').toBe(1)
    expect(row?.retryCount, 'and must not spend the retry budget getting there').toBe(1)
    expect(
      row?.lastError,
      'the crew member sees this string — it must not be a developer message naming the table and op',
    ).not.toMatch(/table=|op=/)
  })

  it('classifies NO_HANDLER as terminal', () => {
    expect(classifyUploadFailure(new UploadDataError('older version', 'NO_HANDLER'))).toBe('terminal')
  })
})
