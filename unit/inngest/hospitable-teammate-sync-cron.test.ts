import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { hospTeammateSyncCron } from '@/lib/inngest/functions/hospitable/teammate-sync-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: QueuedByTable) {
  const counters: Record<string, number> = {}

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.eq     = () => chain
    chain.not    = () => chain

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from }
}

describe('hospTeammateSyncCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches one teammate_sync.requested event per active Hospitable connection', async () => {
    const supabase = makeSupabase({
      integration_connections: [{
        data: [
          { user_id: 'user_1', org_id: 'org_1', external_user_id: 'ext_1' },
          { user_id: 'user_2', org_id: 'org_2', external_user_id: 'ext_2' },
        ],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospTeammateSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith(
      'dispatch-teammate-sync-events',
      [
        { name: 'integration/hospitable.teammate_sync.requested', data: { user_id: 'user_1', org_id: 'org_1', external_user_id: 'ext_1' } },
        { name: 'integration/hospitable.teammate_sync.requested', data: { user_id: 'user_2', org_id: 'org_2', external_user_id: 'ext_2' } },
      ],
    )
  })

  it('is a no-op when there are no active Hospitable connections', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospTeammateSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('falls back a missing external_user_id to an empty string rather than sending it as null/undefined, and dispatches exactly one event for that connection', async () => {
    const supabase = makeSupabase({
      integration_connections: [{
        data: [{ user_id: 'user_1', org_id: 'org_1', external_user_id: null }],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospTeammateSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 1 })
    const sentEvents = (step.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as unknown[]
    expect(sentEvents).toEqual([
      { name: 'integration/hospitable.teammate_sync.requested', data: { user_id: 'user_1', org_id: 'org_1', external_user_id: '' } },
    ])
  })

  it('throws when the connections fetch itself fails, instead of silently dispatching nothing', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: null, error: { message: 'db timeout' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(hospTeammateSyncCron, {
      event: {},
      step:  runAllStep(),
      logger: makeLogger(),
    })).rejects.toThrow('Failed to fetch connections: db timeout')
  })
})
