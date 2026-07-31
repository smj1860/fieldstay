import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { dailyCommsRetention, commsRetentionOrg } from '@/lib/inngest/functions/cron/comms-retention'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// This cron is now a DISPATCHER plus a per-org handler: it used to run one
// `step.run` per org inside a single invocation (150 steps at 150 tenants),
// and now fans out one `org/comms_retention.requested` event per org, with
// all the retention semantics living in `commsRetentionOrg`. Both halves are
// covered below.
//
// The dispatcher's org scan is paginated, so the shared double's `.range()`
// slicing is what makes a multi-page org list actually drain here.
function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

const NOW_MS = Date.parse('2026-07-22T00:00:00.000Z')

describe('dailyCommsRetention (dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fans out one comms-retention event per org', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: [{ id: 'org_1' }, { id: 'org_2' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyCommsRetention, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-comms-retention', [
      expect.objectContaining({
        name: 'org/comms_retention.requested',
        data: expect.objectContaining({ org_id: 'org_1', now_ms: expect.any(Number) }),
      }),
      expect.objectContaining({
        name: 'org/comms_retention.requested',
        data: expect.objectContaining({ org_id: 'org_2', now_ms: expect.any(Number) }),
      }),
    ])
  })

  it('dispatches every org past the PostgREST 1000-row page cap, not just the first page', async () => {
    const orgs = Array.from({ length: 2_300 }, (_, i) => ({ id: `org_${i}` }))
    const supabase = makeSupabase({ organizations: { data: orgs, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyCommsRetention, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2_300 })
    const events = step.sendEvent.mock.calls[0]![1] as { data: { org_id: string } }[]
    expect(events).toHaveLength(2_300)
    expect(events.at(-1)!.data.org_id).toBe('org_2299')
  })

  it('sends nothing at all when the platform has no orgs', async () => {
    const supabase = makeSupabase({ organizations: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyCommsRetention, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})

describe('commsRetentionOrg (per org)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function orgEvent(nowMs = NOW_MS) {
    return { data: { org_id: 'org_1', now_ms: nowMs } }
  }

  it('soft-deletes logs past the retention window and hard-purges logs soft-deleted 30+ days ago', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: { id: 'org_1', comms_log_retention_days: 90 }, error: null },
      ],
      communication_logs: [
        { data: [{ id: 'log_1' }, { id: 'log_2' }], error: null }, // soft-delete update
        { data: [{ id: 'log_3' }], error: null },                  // hard-purge delete
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(commsRetentionOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', soft_deleted: 2, hard_purged: 1 })

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

  it('is a no-op when nothing is past either retention stage for the org', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: { id: 'org_1', comms_log_retention_days: 90 }, error: null },
      ],
      communication_logs: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(commsRetentionOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', soft_deleted: 0, hard_purged: 0 })
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('does nothing but report when the org was deleted between dispatch and delivery', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(commsRetentionOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', soft_deleted: 0, hard_purged: 0, reason: 'org_missing' })
    expect(supabase.calls.some((c) => c.table === 'communication_logs')).toBe(false)
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
          { data: { id: 'org_1', comms_log_retention_days: 1 }, error: null },
        ],
        communication_logs: [
          { data: [], error: null },
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(commsRetentionOrg, {
        event:  orgEvent(),
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const ltCalls = supabase.calls.filter((c) => c.table === 'communication_logs' && c.method === 'lt')
      expect(ltCalls).toHaveLength(2)

      // Soft-delete cutoff honors the org's comms_log_retention_days (1 day here).
      expect(ltCalls[0]!.args).toEqual(['created_at', '2026-07-21T00:00:00.000Z'])

      // Hard-purge cutoff is always fixed at 30 days, independent of the
      // org's retention setting.
      expect(ltCalls[1]!.args).toEqual(['deleted_at', '2026-06-22T00:00:00.000Z'])
    })

    it('the hard-purge cutoff does not shift even when the org has a very long retention window', async () => {
      const supabase = makeSupabase({
        organizations: [
          { data: { id: 'org_1', comms_log_retention_days: 3650 }, error: null },
        ],
        communication_logs: [
          { data: [], error: null },
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(commsRetentionOrg, {
        event:  orgEvent(),
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const ltCalls = supabase.calls.filter((c) => c.table === 'communication_logs' && c.method === 'lt')
      expect(ltCalls[1]!.args).toEqual(['deleted_at', '2026-06-22T00:00:00.000Z'])
    })

    it('anchors both cutoffs on the dispatcher-captured now_ms, not on delivery time', async () => {
      // The dispatcher captures Date.now() once and passes it on every event,
      // so a retry or a slow queue can't shift the window under the handler.
      const supabase = makeSupabase({
        organizations: [
          { data: { id: 'org_1', comms_log_retention_days: 1 }, error: null },
        ],
        communication_logs: [
          { data: [], error: null },
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      // Delivery happens a day after dispatch.
      vi.setSystemTime(new Date('2026-07-23T00:00:00.000Z'))

      await invokeHandler(commsRetentionOrg, {
        event:  orgEvent(NOW_MS),
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const ltCalls = supabase.calls.filter((c) => c.table === 'communication_logs' && c.method === 'lt')
      expect(ltCalls[0]!.args).toEqual(['created_at', '2026-07-21T00:00:00.000Z'])
      expect(ltCalls[1]!.args).toEqual(['deleted_at', '2026-06-22T00:00:00.000Z'])
    })
  })
})
