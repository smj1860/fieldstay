import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

/**
 * A crew-assigned work order has no checklist to infer a start from
 * (`checklist_instances.turnover_id` is NOT NULL), so "Start Work" is an
 * explicit tap, and like every other crew write it has to survive being made
 * with no signal.
 *
 * The hazard this covers is specific. `uploadCrewWorkOrderChange` used to
 * accept exactly one status and throw on anything else, so queueing an
 * `in_progress` mutation before teaching it the new status would have thrown
 * a plain Error on drain — which `classifyUploadFailure` treats as terminal.
 * The crew member's start would dead-letter instead of sending, and the only
 * trace would be a banner entry nobody reads for a button they tapped once.
 *
 * It also pins the ROUTE. The two statuses go to two different endpoints, and
 * nothing else in the suite would notice an `in_progress` mutation quietly
 * being POSTed to /complete — which would complete the work order, fire the
 * owner_transactions maintenance expense, and close a job that had only just
 * been picked up.
 */

const holder = vi.hoisted(() => ({ db: null as unknown, supabase: null as unknown }))

vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (t: string) => (holder.supabase as ReturnType<typeof makeFakeSupabase>).from(t),
  }),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { SyncEngine } from '@/lib/dexie/syncService'

const NOW    = Date.parse('2026-10-12T09:00:00.000Z')
const WO_ID  = 'wo_1'

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

async function seed(payload: Record<string, unknown>): Promise<number> {
  return await db().mutations.add({
    table:      'crew_work_orders',
    targetId:   WO_ID,
    op:         'PATCH',
    payload,
    createdAt:  new Date(NOW).toISOString(),
    retryCount: 0,
    failed:     0,
  }) as number
}

function mockFetch(status = 200) {
  const f = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({}), { status }))
  vi.stubGlobal('fetch', f)
  return f
}

const drain = () => new SyncEngine('user_1').processOutbox()

describe('crew work order start — outbox routing and durability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    holder.db = makeFakeDexieDb()
    holder.supabase = makeFakeSupabase({})
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends an in_progress mutation to /start and clears the outbox row', async () => {
    const id = await seed({ status: 'in_progress' })
    const fetchMock = mockFetch(200)

    await drain()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/crew/work-orders/${WO_ID}/start`)
    expect(await db().mutations.get(id)).toBeUndefined()
  })

  // The whole point of the two-endpoint split. A start that reached /complete
  // would close the job and post the maintenance expense.
  it('never sends a start to the completion endpoint', async () => {
    await seed({ status: 'in_progress' })
    const fetchMock = mockFetch(200)

    await drain()

    expect(fetchMock.mock.calls[0]![0]).not.toContain('/complete')
  })

  it('still routes a completion to /complete, with its notes', async () => {
    await seed({ status: 'completed', notes: 'swapped the valve' })
    const fetchMock = mockFetch(200)

    await drain()

    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/crew/work-orders/${WO_ID}/complete`)
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ notes: 'swapped the valve' })
  })

  it('sends the start with a timeout budget rather than an unbounded fetch', async () => {
    await seed({ status: 'in_progress' })
    const fetchMock = mockFetch(200)

    await drain()

    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal)
  })

  // 5xx is retryable: the row must survive for the next drain rather than
  // being dropped or dead-lettered on the first failure.
  it('keeps the mutation queued when the start route 500s', async () => {
    const id = await seed({ status: 'in_progress' })
    mockFetch(500)

    await drain()

    const row = await db().mutations.get(id) as MutationRow | undefined
    expect(row).toBeDefined()
    expect(row?.failed).not.toBe(1)
  })

  // 409 is the cancelled-work-order refusal. Permanent, so it dead-letters
  // into the banner instead of retrying against a row that will never change.
  it('dead-letters a 409 so the crew member can see it instead of retrying forever', async () => {
    const id = await seed({ status: 'in_progress' })
    mockFetch(409)

    await drain()

    const row = await db().mutations.get(id) as MutationRow | undefined
    expect(row?.failed).toBe(1)
  })

  // The guard that made teaching the handler necessary in the first place.
  it('still throws loudly on a status neither endpoint handles', async () => {
    const id = await seed({ status: 'cancelled' })
    const fetchMock = mockFetch(200)

    await drain()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await db().mutations.get(id)).toBeDefined()
  })
})
