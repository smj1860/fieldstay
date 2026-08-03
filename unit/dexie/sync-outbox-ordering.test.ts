import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

/**
 * Two defects from the 2026-08-03 audit, both of which lose crew work silently.
 *
 * H5 — a head-of-line block that can never dead-letter. A Postgres statement
 *      timeout arrives as UploadDataError('… statement timeout', '57014').
 *      57014 is not 22/23/42 and not PGRST, so it was not terminal; the
 *      message then matched \btimeout\b and it was classified 'network'. The
 *      network branch consumes no retry, never sets `failed`, and STOPS the
 *      drain — so one server-side timeout pinned the outbox head forever,
 *      blocked every later write on the device, and showed nothing in
 *      FailedSyncBanner (which filters on `failed`).
 *
 * H6 — "Retry all" resurrecting a superseded write. Dead-lettering let the
 *      drain continue, so later writes for the SAME record pushed on top of a
 *      gap; clearing `failed` in place then replayed the stale payload as
 *      though it were newest. Tick → dead-letter → un-tick → Retry all → the
 *      server flips back to ticked.
 */

const holder = vi.hoisted(() => ({
  db:       null as unknown,
  supabase: null as unknown,
}))

vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => (holder.supabase as ReturnType<typeof makeFakeSupabase>).from(table),
  }),
}))

import { SyncEngine } from '@/lib/dexie/syncService'
import { classifyUploadFailure, UploadDataError, STALLED_NETWORK_ATTEMPTS } from '@/lib/dexie/net'

const NOW = Date.parse('2026-08-03T09:00:00.000Z')

function db(): FakeDexieDb { return holder.db as FakeDexieDb }
function supabaseCalls() { return (holder.supabase as ReturnType<typeof makeFakeSupabase>).calls }
function mutationRow(id: number) {
  return db().mutations.get(id) as Promise<MutationRow | undefined>
}

function setOnline(value: boolean): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: value },
  })
}

// A Postgres statement timeout: the server DID respond, and said "57014".
const STATEMENT_TIMEOUT = {
  error: { message: 'canceling statement due to statement timeout', code: '57014' },
}
const UPLOAD_OK = { data: [{ id: 'x' }], error: null }

async function seed(overrides: Partial<MutationRow> = {}): Promise<number> {
  const id = await db().mutations.add({
    table:      'checklist_instance_items',
    targetId:   'item_1',
    op:         'PATCH',
    payload:    { is_completed: true },
    createdAt:  new Date(NOW).toISOString(),
    retryCount: 0,
    ...overrides,
  })
  return id as number
}

describe('classifyUploadFailure — a coded error reached the server', () => {
  beforeEach(() => setOnline(true))

  it('classifies a statement timeout as transient, NOT network', () => {
    const err = new UploadDataError(
      'checklist_instance_items upload failed: canceling statement due to statement timeout',
      '57014',
    )
    // 'network' would mean: never consume a retry, never dead-letter, block
    // the drain forever.
    expect(classifyUploadFailure(err)).toBe('transient')
  })

  it('still classifies a genuine transport failure as network', () => {
    expect(classifyUploadFailure(new TypeError('Failed to fetch'))).toBe('network')
    expect(classifyUploadFailure(new Error('The network connection was lost'))).toBe('network')
  })

  it('still classifies an RLS/constraint rejection as terminal', () => {
    expect(classifyUploadFailure(new UploadDataError('denied', '42501'))).toBe('terminal')
    expect(classifyUploadFailure(new UploadDataError('dupe', '23505'))).toBe('terminal')
  })

  it('classifies an uncoded timeout message as network (transport still wins without a code)', () => {
    // No code => nothing proves it reached the server.
    expect(classifyUploadFailure(new Error('request timed out'))).toBe('network')
  })
})

describe('outbox — a server timeout no longer blocks the queue forever', () => {
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

  it('spends the retry budget and eventually dead-letters into a visible surface', async () => {
    const id = await seed()
    holder.supabase = makeFakeSupabase({
      checklist_instance_items: Array.from({ length: 12 }, () => STATEMENT_TIMEOUT),
    })

    const engine = new SyncEngine('u1')
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(NOW + i * 600_000)   // step past each backoff window
      await engine.processOutbox()
    }

    const row = await mutationRow(id)
    expect(row?.retryCount, 'a server-side timeout must consume the retry budget').toBeGreaterThan(0)
    expect(row?.failed, 'and must eventually become visible to the crew member').toBe(true)
  })
})

describe('outbox — dead-lettering preserves a record\'s mutation order (H6)', () => {
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

  it('holds back later changes to the SAME record when one dead-letters', async () => {
    // The audit's exact scenario: tick, then un-tick, with the tick failing.
    const tickId   = await seed({ payload: { is_completed: true } })
    const untickId = await seed({ payload: { is_completed: false } })

    holder.supabase = makeFakeSupabase({
      checklist_instance_items: Array.from({ length: 20 }, () => ({
        error: { message: 'denied by policy', code: '42501' },   // terminal
      })),
    })

    const engine = new SyncEngine('u1')
    await engine.processOutbox()

    expect((await mutationRow(tickId))?.failed, 'the tick dead-letters').toBe(true)
    expect(
      (await mutationRow(untickId))?.failed,
      'the un-tick must be held back, or Retry all replays the tick ON TOP of it',
    ).toBe(true)

    // The un-tick never reached the server, so there is no newer server state
    // for a later Retry-all replay of the tick to clobber. (`calls` records
    // every chain method, not one entry per push — so assert on the PAYLOAD
    // rather than the call count.)
    const sentPayloads = supabaseCalls()
      .filter((c) => c.method === 'update')
      .map((c) => c.args[0] as Record<string, unknown>)

    expect(
      sentPayloads.some((p) => p.is_completed === false),
      'the held-back un-tick must not be pushed',
    ).toBe(false)
  })

  it('does NOT hold back changes to a different record', async () => {
    const failing = await seed({ targetId: 'item_1' })
    const other   = await seed({ targetId: 'item_2' })

    holder.supabase = makeFakeSupabase({
      checklist_instance_items: [
        { error: { message: 'denied by policy', code: '42501' } },  // item_1 → terminal
        UPLOAD_OK,                                                   // item_2 → succeeds
      ],
    })

    const engine = new SyncEngine('u1')
    await engine.processOutbox()

    expect((await mutationRow(failing))?.failed).toBe(true)
    expect(
      await mutationRow(other),
      'an unrelated record must still drain — blocking everything was the bug this replaced',
    ).toBeUndefined()
  })
})

describe('stalled-outbox visibility threshold', () => {
  it('is a small positive number so a stuck queue surfaces within a shift', () => {
    expect(STALLED_NETWORK_ATTEMPTS).toBeGreaterThan(0)
    expect(STALLED_NETWORK_ATTEMPTS).toBeLessThanOrEqual(10)
  })
})
