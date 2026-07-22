import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { dailyCommsRetention } from '@/lib/inngest/functions/cron/comms-retention'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Cron function — no meaningful `data` on the real event (only wall-clock
// date driven), so `event` is `{}`, mirroring cron-vendor-compliance-grace-check.

// Queue-based `.from(table)` mock, same convention as the other retention
// crons in this batch. `communication_logs` is queried twice per org (soft
// -delete update, then hard-purge delete) so order matters.
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
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.lt     = (...a: unknown[]) => record('lt', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.delete = (...a: unknown[]) => record('delete', a)

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

describe('dailyCommsRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('soft-deletes logs past the retention window and hard-purges logs soft-deleted 30+ days ago', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: [{ id: 'org_1', comms_log_retention_days: 90 }], error: null },
      ],
      communication_logs: [
        { data: [{ id: 'log_1' }, { id: 'log_2' }], error: null }, // soft-delete update
        { data: [{ id: 'log_3' }], error: null },                  // hard-purge delete
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyCommsRetention, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ comms_soft_deleted: 2, comms_hard_purged: 1 })

    const softUpdate = supabase.calls.find((c) => c.table === 'communication_logs' && c.method === 'update')
    expect(softUpdate?.args[0]).toMatchObject({ deleted_at: expect.any(String) })

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        orgId:      'org_1',
        action:     'comms.log.deleted',
        targetType: 'communication_log',
        metadata:   expect.objectContaining({ source: 'retention_cron', count: 2, stage: 'soft_delete' }),
      }),
      expect.objectContaining({
        orgId:      'org_1',
        action:     'comms.log.deleted',
        targetType: 'communication_log',
        metadata:   expect.objectContaining({ source: 'retention_cron', count: 1, stage: 'hard_purge' }),
      }),
    ])
  })

  it('is a no-op when nothing is past either retention stage for any org', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: [{ id: 'org_1', comms_log_retention_days: 90 }], error: null },
      ],
      communication_logs: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyCommsRetention, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ comms_soft_deleted: 0, comms_hard_purged: 0 })
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  describe('retention-window cutoff date math', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('uses the org-configured window for soft-delete and a fixed 30-day window for hard-purge', async () => {
      const supabase = makeSupabase({
        organizations: [
          { data: [{ id: 'org_1', comms_log_retention_days: 1 }], error: null },
        ],
        communication_logs: [
          { data: [], error: null },
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(dailyCommsRetention, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const ltCalls = supabase.calls.filter((c) => c.table === 'communication_logs' && c.method === 'lt')
      expect(ltCalls).toHaveLength(2)

      // Soft-delete cutoff honors the org's comms_log_retention_days (1 day here).
      expect(ltCalls[0].args).toEqual(['created_at', '2026-07-21T00:00:00.000Z'])

      // Hard-purge cutoff is always fixed at 30 days, independent of the
      // org's retention setting.
      expect(ltCalls[1].args).toEqual(['deleted_at', '2026-06-22T00:00:00.000Z'])
    })

    it('the hard-purge cutoff does not shift even when the org has a very long retention window', async () => {
      const supabase = makeSupabase({
        organizations: [
          { data: [{ id: 'org_1', comms_log_retention_days: 3650 }], error: null },
        ],
        communication_logs: [
          { data: [], error: null },
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(dailyCommsRetention, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const ltCalls = supabase.calls.filter((c) => c.table === 'communication_logs' && c.method === 'lt')
      expect(ltCalls[1].args).toEqual(['deleted_at', '2026-06-22T00:00:00.000Z'])
    })
  })
})
