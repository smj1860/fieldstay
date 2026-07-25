import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { notificationsRetentionCron } from '@/lib/inngest/functions/cron/notifications-retention'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// Cron function — no meaningful `data` on the real event (only wall-clock
// date driven), so `event` is `{}`, mirroring cron-comms-retention.
//
// Queue-based `.from(table)` mock, same convention as the other retention
// crons. `notifications` is hit in select/delete pairs (select a bounded
// batch of ids, delete by id) per retention policy, so order matters:
//   [read>90d select, read>90d delete, all>180d select, all>180d delete, ...]
// A select that returns [] is NOT followed by a delete (the batch loop
// stops), so queue entries must account for that.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.lt     = (...a: unknown[]) => record('lt', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.delete = (...a: unknown[]) => record('delete', a)
    chain.in     = (...a: unknown[]) => record('in', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function ids(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${i}` }))
}

describe('notificationsRetentionCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('purges read rows past 90 days and all rows past 180 days, deleting by bounded id batches', async () => {
    const supabase = makeSupabase({
      notifications: [
        { data: [{ id: 'n_1' }, { id: 'n_2' }], error: null }, // read>90d select
        { data: null, error: null },                            // read>90d delete
        { data: [{ id: 'n_3' }], error: null },                 // all>180d select
        { data: null, error: null },                            // all>180d delete
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const logger = { info: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(notificationsRetentionCron, {
      event: {},
      step:  makeStep(),
      logger,
    })

    expect(result).toEqual({ read_deleted: 2, max_age_deleted: 1, exhausted: true })

    // Every delete is bounded by an explicit id list — never an open-ended filter.
    const inCalls = supabase.calls.filter((c) => c.method === 'in')
    expect(inCalls).toHaveLength(2)
    expect(inCalls[0].args).toEqual(['id', ['n_1', 'n_2']])
    expect(inCalls[1].args).toEqual(['id', ['n_3']])

    // The 90-day pass targets read rows only; the 180-day pass has no read_at filter.
    const notCalls = supabase.calls.filter((c) => c.method === 'not')
    expect(notCalls).toHaveLength(1)
    expect(notCalls[0].args).toEqual(['read_at', 'is', null])

    // Counts only in the log line — never notification content.
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('read>90d deleted: 2') as unknown as string,
    )
  })

  it('is a no-op when nothing has aged past either retention window', async () => {
    const supabase = makeSupabase({
      notifications: [
        { data: [], error: null }, // read>90d select — empty, no delete follows
        { data: [], error: null }, // all>180d select — empty, no delete follows
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notificationsRetentionCron, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ read_deleted: 0, max_age_deleted: 0, exhausted: true })
    expect(supabase.calls.filter((c) => c.method === 'delete')).toHaveLength(0)
  })

  it('keeps deleting in batches until a short batch signals the backlog is exhausted', async () => {
    const supabase = makeSupabase({
      notifications: [
        { data: ids(500, 'a'), error: null }, // read>90d batch 1 — full, loop again
        { data: null, error: null },
        { data: ids(120, 'b'), error: null }, // read>90d batch 2 — short, stop
        { data: null, error: null },
        { data: [], error: null },            // all>180d — nothing
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notificationsRetentionCron, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ read_deleted: 620, max_age_deleted: 0, exhausted: true })

    const limitCalls = supabase.calls.filter((c) => c.method === 'limit')
    expect(limitCalls.every((c) => c.args[0] === 500)).toBe(true)
  })

  it('reports exhausted: false when a run hits the per-run batch ceiling', async () => {
    // 20 full batches for the read>90d pass (the MAX_BATCHES_PER_RUN ceiling),
    // then an empty all>180d pass.
    const queue: { data?: unknown; error?: unknown }[] = []
    for (let i = 0; i < 20; i++) {
      queue.push({ data: ids(500, `batch${i}`), error: null })
      queue.push({ data: null, error: null })
    }
    queue.push({ data: [], error: null })

    const supabase = makeSupabase({ notifications: queue })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const logger = { info: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(notificationsRetentionCron, {
      event: {},
      step:  makeStep(),
      logger,
    })

    expect(result).toEqual({ read_deleted: 10_000, max_age_deleted: 0, exhausted: false })
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('batch ceiling hit') as unknown as string,
    )
  })

  it('throws when a query errors, so Inngest retries the step', async () => {
    const supabase = makeSupabase({
      notifications: [
        { data: null, error: { message: 'connection reset' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(notificationsRetentionCron, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow('notifications retention select failed: connection reset')
  })

  describe('retention-window cutoff date math', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-25T14:30:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('uses a 90-day cutoff for read rows and a 180-day cutoff for all rows', async () => {
      const supabase = makeSupabase({
        notifications: [
          { data: [], error: null },
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(notificationsRetentionCron, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const ltCalls = supabase.calls.filter((c) => c.method === 'lt')
      expect(ltCalls).toHaveLength(2)
      expect(ltCalls[0].args).toEqual(['created_at', '2026-04-26T14:30:00.000Z'])  // 90 days
      expect(ltCalls[1].args).toEqual(['created_at', '2026-01-26T14:30:00.000Z'])  // 180 days
    })
  })
})
