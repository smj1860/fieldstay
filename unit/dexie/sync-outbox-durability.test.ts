import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

// The three durability properties the crew PWA's entire value proposition
// rests on, each of which was violated in production:
//
//  1. An attempt made with no connection must not consume the retry budget
//     (it did: 30 s interval × no online gate → dead-lettered in ~75 s).
//  2. A transport failure must never dead-letter, no matter how long the
//     outage lasts.
//  3. Mutations against the same record must be pushed in insertion order,
//     never reordered (the `if (newRetryCount >= 3) continue` skip let
//     completeTurnover jump ahead of a failing startTurnover).

const holder = vi.hoisted(() => ({
  db:       null as unknown,
  supabase: null as unknown,
  online:   true,
}))

vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  // Logout shutdown latch (lib/dexie/schema.ts) — never latched in these tests.
  isDexieShutdown: () => false,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => (holder.supabase as ReturnType<typeof makeFakeSupabase>).from(table),
  }),
}))

import { SyncEngine } from '@/lib/dexie/syncService'

const NOW = Date.parse('2026-07-30T09:00:00.000Z')

function db(): FakeDexieDb { return holder.db as FakeDexieDb }
function supabaseCalls() { return (holder.supabase as ReturnType<typeof makeFakeSupabase>).calls }

const UPLOAD_OK   = { data: [{ id: 'item1' }], error: null }
const SERVER_FAIL = { error: { message: 'server exploded', code: 'XX000' } }

async function seedMutation(overrides: Partial<MutationRow> = {}): Promise<number> {
  const id = await db().mutations.add({
    table:      'checklist_instance_items',
    targetId:   'item1',
    op:         'PATCH',
    payload:    { is_completed: 1 },
    createdAt:  new Date(NOW).toISOString(),
    retryCount: 0,
    // Always present, never undefined — drain() reads the outbox through
    // `.where('failed').equals(0)` and IndexedDB leaves a record out of an
    // index entirely when the indexed property is absent. Before `...overrides`
    // so a test seeding a dead letter still gets one.
    failed: 0 as const,
    ...overrides,
  })
  return id as number
}

function mutationRow(id: number) {
  return db().mutations.get(id) as Promise<MutationRow | undefined>
}

function setOnline(value: boolean): void {
  holder.online = value
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: value },
  })
}

describe('outbox durability — offline attempts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    holder.db = makeFakeDexieDb()
    holder.supabase = makeFakeSupabase({})
    setOnline(true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('never attempts a push while offline and never charges a retry for it', async () => {
    const id = await seedMutation()
    // Any queued response here would be a bug to consume — offline means
    // the drain must not touch the network at all.
    holder.supabase = makeFakeSupabase({ checklist_instance_items: [UPLOAD_OK] })
    setOnline(false)

    const engine = new SyncEngine('u1')
    // 20 interval ticks — far past the old MAX_RETRIES = 5 (~75 s) window.
    for (let i = 0; i < 20; i++) await engine.processOutbox()

    expect(supabaseCalls()).toHaveLength(0)
    const row = await mutationRow(id)
    expect(row).toBeDefined()
    expect(row!.retryCount).toBe(0)
    // 0 = queued and live. `failed` is never absent: the drain queries the
    // index, and IndexedDB omits records whose indexed property is undefined.
    expect(row!.failed).toBe(0)
  })

  it('pushes the untouched mutation as soon as the device is back online', async () => {
    const id = await seedMutation()
    setOnline(false)
    const engine = new SyncEngine('u1')
    await engine.processOutbox()

    holder.supabase = makeFakeSupabase({ checklist_instance_items: [UPLOAD_OK] })
    setOnline(true)
    await engine.processOutbox()

    expect(await mutationRow(id)).toBeUndefined()
    expect(supabaseCalls().filter((c) => c.method === 'update')).toHaveLength(1)
  })

  it('a transport failure retries forever and never dead-letters', async () => {
    const id = await seedMutation()
    // navigator reports online (captive portal / dropped socket): fetch-level
    // failure, not a server rejection.
    holder.supabase = makeFakeSupabase({
      // Generous: each loop iteration below drains twice (the direct call
      // plus the backoff timer it scheduled), and an exhausted queue would
      // fall back to a success-shaped empty response.
      checklist_instance_items: Array.from({ length: 400 }, () => ({ error: { message: 'TypeError: Failed to fetch' } })),
    })

    const engine = new SyncEngine('u1')
    for (let i = 0; i < 30; i++) {
      await engine.processOutbox()
      // Skip past whatever backoff window the last failure set.
      await vi.advanceTimersByTimeAsync(600_000)
    }

    const row = await mutationRow(id)
    expect(row, 'a transport failure must never destroy the mutation').toBeDefined()
    expect(row!.failed, 'transport failures must never dead-letter').toBe(0)
    expect(row!.retryCount, 'transport failures must not consume the retry budget').toBe(0)
    expect(row!.networkRetryCount!).toBeGreaterThan(5)
  })

  it('a genuine server rejection still dead-letters at MAX_RETRIES', async () => {
    const id = await seedMutation()
    holder.supabase = makeFakeSupabase({
      checklist_instance_items: Array.from({ length: 10 }, () => SERVER_FAIL),
    })

    const engine = new SyncEngine('u1')
    for (let i = 0; i < 6; i++) {
      await engine.processOutbox()
      await vi.advanceTimersByTimeAsync(600_000)
    }

    expect(await mutationRow(id)).toMatchObject({ retryCount: 5, failed: 1 })
  })
})

describe('outbox durability — ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    holder.db = makeFakeDexieDb()
    setOnline(true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('never lets a later mutation jump ahead of a repeatedly-failing earlier one', async () => {
    // The exact production failure: a flaky `start` followed by `complete`
    // on the SAME turnover. If `start` is skipped after three attempts,
    // `complete` is pushed first, the turnover ends up completed with
    // started_at NULL, and `/start` then no-ops with a 200.
    const pushed: string[] = []
    let startAttempts = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/start')) {
        startAttempts += 1
        // Fails four times — one more than the old skip-ahead threshold.
        if (startAttempts <= 4) return { ok: false, status: 503 } as Response
        pushed.push('start')
        return { ok: true, status: 200 } as Response
      }
      pushed.push('complete')
      return { ok: true, status: 200 } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    await db().mutations.add({
      table: 'turnovers', targetId: 't1', op: 'PATCH',
      payload: { status: 'in_progress' }, createdAt: new Date(NOW).toISOString(), retryCount: 0,
    failed: 0,
  })
    await db().mutations.add({
      table: 'turnovers', targetId: 't1', op: 'PATCH',
      payload: { status: 'completed' }, createdAt: new Date(NOW).toISOString(), retryCount: 0,
    failed: 0,
  })

    const engine = new SyncEngine('u1')
    for (let i = 0; i < 6; i++) {
      await engine.processOutbox()
      await vi.advanceTimersByTimeAsync(600_000)
    }

    expect(pushed, 'start must reach the server before complete').toEqual(['start', 'complete'])
    expect(await db().mutations.toArray()).toHaveLength(0)
  })

  it('a dead-lettered mutation does not permanently block unrelated records', async () => {
    // Ordering is per-record, not global: a mutation that can never succeed
    // must not strand every other record's work behind it forever.
    const pushed: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/t-bad/')) return { ok: false, status: 400 } as Response  // terminal
      pushed.push(url)
      return { ok: true, status: 200 } as Response
    }))

    await db().mutations.add({
      table: 'turnovers', targetId: 't-bad', op: 'PATCH',
      payload: { status: 'completed' }, createdAt: new Date(NOW).toISOString(), retryCount: 0,
    failed: 0,
  })
    await db().mutations.add({
      table: 'turnovers', targetId: 't-good', op: 'PATCH',
      payload: { status: 'completed' }, createdAt: new Date(NOW).toISOString(), retryCount: 0,
    failed: 0,
  })

    await new SyncEngine('u1').processOutbox()

    // A 4xx will never succeed on replay — dead-lettered on the first
    // attempt rather than burning five retries, and the queue moves on.
    const rows = await db().mutations.toArray() as unknown as MutationRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetId: 't-bad', failed: 1 })
    expect(pushed.some((u) => u.includes('t-good'))).toBe(true)
  })
})

// ============================================================================
// The indexed drain, and the trap under it.
//
// drain() used to be `orderBy('id').toArray()` then `.filter(m => !m.failed)` —
// every row, live and dead-lettered, materialised on every drain: each
// enqueueMutation, each reconnect, and the 30-second tick. Dead letters are
// kept for DEAD_LETTER_RETENTION_DAYS, so a device with a bad month of signal
// re-materialised a growing table ~2,880 times a day to find the few rows it
// could send.
//
// Switching to `.where('failed').equals(0)` is only safe because `failed` is
// now written on EVERY row. IndexedDB omits a record from an index when the
// indexed property is undefined, and enqueueMutationTx used to set `failed`
// only on the held-back branch — so the naive index swap would have made every
// ordinary queued mutation invisible to the drain. Not slower. Silent. Nothing
// would sync and nothing would say why.
// ============================================================================
describe('outbox drain reads the index, not the whole table', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    holder.db = makeFakeDexieDb()
    holder.supabase = makeFakeSupabase({ checklist_instance_items: [UPLOAD_OK] })
    vi.stubGlobal('navigator', { onLine: true })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('every enqueued mutation carries failed = 0, so none is invisible to the index', async () => {
    const { enqueueMutationTx } = await import('@/lib/dexie/syncService')
    const d = db()
    await d.transaction('rw', d.mutations, () =>
      enqueueMutationTx(d as never, 'checklist_instance_items', 'item1', 'PATCH', { is_completed: 1 }),
    )

    const rows = await d.mutations.toArray()
    expect(rows).toHaveLength(1)
    // `undefined` here is the silent-outbox bug: the row exists, looks healthy
    // in any dump, and is absent from `where('failed')` forever.
    expect(rows[0]!.failed).toBe(0)

    const indexed = await d.mutations.where('failed').equals(0).sortBy('id')
    expect(indexed).toHaveLength(1)
  })

  it('a dead letter is excluded by the index rather than loaded and filtered out', async () => {
    await seedMutation({ targetId: 'live' })
    await seedMutation({ targetId: 'dead', failed: 1, retryCount: 5 })

    const live = await db().mutations.where('failed').equals(0).sortBy('id')
    expect(live.map((m) => m.targetId)).toEqual(['live'])
  })

  it('still drains in insertion order — the index supplies membership, sortBy supplies order', async () => {
    // Per-record replay ordering depends on this; an index scan is ordered by
    // the indexed key, not by id, so the explicit sort is load-bearing.
    const d = db()
    await seedMutation({ targetId: 'a' })
    await seedMutation({ targetId: 'b' })
    await seedMutation({ targetId: 'c' })

    const order = (await d.mutations.where('failed').equals(0).sortBy('id')).map((m) => m.targetId)
    expect(order).toEqual(['a', 'b', 'c'])
  })
})
