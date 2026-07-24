import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { hospCalendarSyncCron } from '@/lib/inngest/functions/hospitable/calendar-sync-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// Every step body runs for real — the only external boundary is Supabase.
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
    chain.in     = () => chain
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

describe('hospCalendarSyncCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches one calendar_sync.requested event per active property, picking the owner over an admin when both exist for the same org', async () => {
    const supabase = makeSupabase({
      integration_connections: [{
        data: [{ org_id: 'org_1' }, { org_id: 'org_2' }],
        error: null,
      }],
      properties: [{
        data: [
          { id: 'prop_1', org_id: 'org_1', external_id: 'hosp_1' },
          { id: 'prop_2', org_id: 'org_2', external_id: 'hosp_2' },
        ],
        error: null,
      }],
      organization_members: [{
        data: [
          { org_id: 'org_1', user_id: 'admin_1', role: 'admin' },
          { org_id: 'org_1', user_id: 'owner_1', role: 'owner' }, // must win over admin_1 for org_1
          { org_id: 'org_2', user_id: 'admin_2', role: 'admin' },
        ],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospCalendarSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith(
      'dispatch-calendar-sync-events',
      [
        {
          name: 'integration/hospitable.calendar_sync.requested',
          data: { property_id: 'prop_1', org_id: 'org_1', user_id: 'owner_1', hospitable_property_id: 'hosp_1' },
        },
        {
          name: 'integration/hospitable.calendar_sync.requested',
          data: { property_id: 'prop_2', org_id: 'org_2', user_id: 'admin_2', hospitable_property_id: 'hosp_2' },
        },
      ],
    )
  })

  it('is a no-op when there are no active Hospitable-sourced properties', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [{ org_id: 'org_1' }], error: null }],
      properties: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospCalendarSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
    // Reaches the properties query (org has an active connection) but stops there.
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('is a no-op and never queries properties when there are no active Hospitable connections at all', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospCalendarSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0, skipped_reason: 'no_active_connections' })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('integration_connections')
  })

  it('excludes a property whose org has no active connection even though is_active/external_source still say Hospitable', async () => {
    const supabase = makeSupabase({
      // Only org_1 has an active connection — org_2 disconnected but its
      // property row was never touched by disconnectIntegration().
      integration_connections: [{ data: [{ org_id: 'org_1' }], error: null }],
      properties: [{
        data: [{ id: 'prop_1', org_id: 'org_1', external_id: 'hosp_1' }],
        error: null,
      }],
      organization_members: [{
        data: [{ org_id: 'org_1', user_id: 'owner_1', role: 'owner' }],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospCalendarSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 1 })
    const sentEvents = (step.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as unknown[]
    expect(sentEvents).toEqual([
      {
        name: 'integration/hospitable.calendar_sync.requested',
        data: { property_id: 'prop_1', org_id: 'org_1', user_id: 'owner_1', hospitable_property_id: 'hosp_1' },
      },
    ])
  })

  it('filters out a property whose org has no admin/owner member, dispatching for none and sending no events', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [{ org_id: 'org_orphan' }], error: null }],
      properties: [{
        data: [{ id: 'prop_1', org_id: 'org_orphan', external_id: 'hosp_1' }],
        error: null,
      }],
      organization_members: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospCalendarSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('dispatches exactly one event per property even when its org has more than one qualifying admin — no duplicate dispatch per property', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [{ org_id: 'org_1' }], error: null }],
      properties: [{
        data: [{ id: 'prop_1', org_id: 'org_1', external_id: 'hosp_1' }],
        error: null,
      }],
      organization_members: [{
        data: [
          { org_id: 'org_1', user_id: 'admin_a', role: 'admin' },
          { org_id: 'org_1', user_id: 'admin_b', role: 'admin' },
        ],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospCalendarSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 1 })
    const sentEvents = (step.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as unknown[]
    expect(sentEvents).toHaveLength(1)
  })
})
