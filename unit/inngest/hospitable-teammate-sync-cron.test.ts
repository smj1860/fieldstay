import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { hospTeammateSyncCron } from '@/lib/inngest/functions/hospitable/teammate-sync-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

// Uses the ONE shared query-builder double rather than a local hand-roll.
// The local version modelled only .select/.eq/.not, so it broke the moment
// this cron's connection read was paginated onto .order().range() — which is
// precisely the divergence unit/stubs/supabase-query-double.ts exists to end.
// It also paginates for real, so a >1000-row fixture is genuinely walked.
const makeSupabase = (tables: Record<string, TableSpec>) => createSupabaseDouble(tables)

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
    })).rejects.toThrow(/db timeout/)
  })

  it('dispatches for every connection past the first page, not just the first 1000', async () => {
    // The regression this encodes: this is a PLATFORM-WIDE read of every
    // active Hospitable connection. Unpaginated, PostgREST caps it at
    // max_rows = 1000 and returns a 200 with no truncation signal, so every
    // connection past the cap silently stops being resynced while the cron
    // still reports success.
    const connections = Array.from({ length: 1_450 }, (_, i) => ({
      user_id: `user_${i}`, org_id: `org_${i}`, external_user_id: `ext_${i}`,
    }))
    // Fixed spec: .range() really slices it, so fetchAllRows drains two pages.
    const supabase = makeSupabase({ integration_connections: { data: connections, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = runAllStep()
    const result = await invokeHandler(hospTeammateSyncCron, {
      event: {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 1_450 })
  })
})
