// processOutbox() is invoked as `void getSyncEngine(userId).processOutbox()`
// at seven call sites. `void` asserts the promise handles its own errors — it
// did not: the method had a `finally` but no `catch`, so anything escaping the
// drain became an unhandled rejection in the crew PWA.
//
// The routine trigger is not a defect. listenForRemoteShutdown (schema.ts)
// closes the Dexie connection SYNCHRONOUSLY inside the BroadcastChannel
// handler when a sibling tab logs out — deliberately, so the tab doing the
// delete is not blocked waiting on this one. Any drain mid-await at that
// instant is rejected by Dexie with DatabaseClosedError. It surfaced as an
// intermittent "Unhandled Rejection: DatabaseClosedError" in CI, attributed to
// whichever test happened to be running.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

const holder = vi.hoisted(() => ({
  db:       null as unknown,
  supabase: null as unknown,
  stopped:  false,
}))

vi.mock('@/lib/dexie/schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dexie/schema')>()),
  getDexieDb: () => holder.db,
  isDexieShutdown: () => holder.stopped,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => (holder.supabase as ReturnType<typeof makeFakeSupabase>).from(table),
  }),
}))

import { SyncEngine } from '@/lib/dexie/syncService'
import { isDatabaseClosedError } from '@/lib/dexie/schema'
import { reportError } from '@/lib/observability/report-error'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

async function seed(overrides: Partial<MutationRow> = {}): Promise<void> {
  await db().mutations.add({
    table:      'checklist_instance_items',
    targetId:   'item1',
    op:         'PATCH',
    payload:    { is_completed: 1 },
    createdAt:  new Date().toISOString(),
    retryCount: 0,
    // Required, not cosmetic. The drain reads
    // `where('failed').equals(0).sortBy('id')`, and IndexedDB omits a record
    // from an index when the indexed property is undefined — so a row seeded
    // without `failed` is invisible to the drain, in the fake (which models
    // this deliberately, see matchesKey in fake-dexie.ts) and in the real
    // thing alike. enqueueMutation writes `failed: 0 as const` on every row;
    // this mirrors it, as every other unit/dexie test already does.
    failed:     0 as const,
    ...overrides,
  })
}

function setOnline(value: boolean): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: value } })
}

/** Set when the injected rejection actually fired — see assertInjectionFired. */
let injectionFired = false

/**
 * Rejects the read drain() actually makes — the first await after the
 * connection is opened, and so the realistic point for a sibling tab's
 * close() to land.
 *
 * That read is `db.mutations.where('failed').equals(0).sortBy('id')`. It used
 * to be `orderBy('id').toArray()`, and this helper used to override THAT. When
 * the drain moved to the indexed read, the override stopped intercepting
 * anything: nothing rejected, so the two tests that assert on the failure path
 * failed outright — and the one asserting the rejection is SWALLOWED went on
 * passing, vacuously, because a drain that never throws also never reports.
 * Hence assertInjectionFired below; a green test that stopped touching its
 * subject is worse than a red one.
 *
 * Only the `failed` index is wrapped. drain() also issues
 * `where('[table+targetId]')` lookups for successor hold-back, and rejecting
 * those too would model a failure this test isn't about.
 */
function rejectDrainRead(err: Error): void {
  /* eslint-disable @typescript-eslint/no-explicit-any -- fake db, not a real FieldStayDexie */
  const table = db().mutations as any
  const originalWhere = table.where.bind(table)
  table.where = (index: string) => {
    const chain = originalWhere(index)
    if (index !== 'failed') return chain
    return {
      ...chain,
      equals: (value: unknown) => ({
        ...chain.equals(value),
        sortBy: () => {
          injectionFired = true
          return Promise.reject(err)
        },
      }),
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * The drain must actually have hit the injected rejection. Without this, a
 * future change to how drain() reads the outbox silently turns these tests
 * into assertions about nothing — which is exactly what happened once.
 */
function assertInjectionFired(): void {
  expect(
    injectionFired,
    'the injected rejection never fired — drain() no longer reads the outbox via ' +
    "where('failed').equals(0).sortBy('id'), so this test is no longer exercising " +
    'the catch it exists to pin. Repoint rejectDrainRead at the new read.',
  ).toBe(true)
}

/** What Dexie rejects with once the handle has been closed under a drain. */
function databaseClosedError(): Error {
  const err = new Error('Database has been closed')
  err.name = 'DatabaseClosedError'
  return err
}

beforeEach(() => {
  holder.db       = makeFakeDexieDb()
  holder.supabase = makeFakeSupabase({})
  holder.stopped  = false
  injectionFired  = false
  setOnline(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('isDatabaseClosedError', () => {
  it('matches on name, since Dexie error classes do not survive bundling', () => {
    expect(isDatabaseClosedError(databaseClosedError())).toBe(true)
  })

  it('matches the nested form Dexie uses when it wraps a rejection', () => {
    expect(isDatabaseClosedError({ name: 'DexieError', inner: { name: 'DatabaseClosedError' } })).toBe(true)
  })

  it('does not swallow unrelated failures', () => {
    expect(isDatabaseClosedError(new TypeError('fetch failed'))).toBe(false)
    expect(isDatabaseClosedError(null)).toBe(false)
    expect(isDatabaseClosedError('DatabaseClosedError')).toBe(false)
  })
})

describe('processOutbox never rejects — every caller invokes it with `void`', () => {
  it('swallows the DatabaseClosedError a sibling tab logout causes', async () => {
    await seed()
    // A tab logging out elsewhere closes the connection mid-drain.
    rejectDrainRead(databaseClosedError())

    const engine = new SyncEngine('u1')

    await expect(
      engine.processOutbox(),
      'a rejection here is unhandled at every call site — `void processOutbox()`',
    ).resolves.toBeUndefined()

    assertInjectionFired()
    expect(
      vi.mocked(reportError),
      'a closed database during shutdown is the mechanism working, not an incident to report',
    ).not.toHaveBeenCalled()
  })

  it('reports a genuinely unexpected drain failure instead of hiding it', async () => {
    await seed()
    rejectDrainRead(new TypeError('something actually broke'))

    await expect(new SyncEngine('u1').processOutbox()).resolves.toBeUndefined()

    assertInjectionFired()
    expect(
      vi.mocked(reportError),
      'the catch must not become a blanket silencer — only shutdown is expected',
    ).toHaveBeenCalled()
  })

  it('stays re-entrant after a failure rather than latching isProcessing', async () => {
    // The failure path runs through `finally`, so a drain that threw must not
    // leave the engine permanently convinced a drain is still in flight.
    await seed()
    rejectDrainRead(databaseClosedError())

    const engine = new SyncEngine('u1')
    await engine.processOutbox()
    assertInjectionFired()

    // Storage recovers (a fresh login on the same tab clears the latch).
    holder.db = makeFakeDexieDb()
    await seed()
    holder.supabase = makeFakeSupabase({
      checklist_instance_items: [{ data: [{ id: 'item1' }], error: null }],
    })

    await engine.processOutbox()

    expect(
      await db().mutations.toArray(),
      'the engine stopped draining forever after one closed-database rejection',
    ).toHaveLength(0)
  })
})
