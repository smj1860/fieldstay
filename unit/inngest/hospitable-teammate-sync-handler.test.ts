import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  getValidHospitableToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable', () => ({
  hospFetchTeammates:            vi.fn(),
  hospitableTeammatesToCrewRows: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { hospTeammateSyncHandler } from '@/lib/inngest/functions/hospitable/teammate-sync-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { hospFetchTeammates, hospitableTeammatesToCrewRows } from '@/lib/integrations/providers/hospitable'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: QueuedByTable) {
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
    chain.update = (...a: unknown[]) => record('update', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
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

const EVENT_DATA = { user_id: 'user_1', org_id: 'org_1', external_user_id: 'ext_1' }

describe('hospTeammateSyncHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
  })

  it('upserts fresh teammates and deactivates a previously-active crew member no longer present in Hospitable', async () => {
    ;(hospFetchTeammates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'tm_1', name: 'Jane Cleaner' },
    ])
    ;(hospitableTeammatesToCrewRows as ReturnType<typeof vi.fn>).mockReturnValue([
      { org_id: 'org_1', name: 'Jane Cleaner', external_id: 'tm_1', external_source: 'hospitable' },
    ])
    const supabase = makeSupabase({
      crew_members: [
        { error: null }, // upsert-teammates
        {                // existing active crew_members for this org/source
          data: [
            { id: 'crew_active', external_id: 'tm_1' },   // still present — must not be deactivated
            { id: 'crew_gone',   external_id: 'tm_old' },  // removed from Hospitable — must be deactivated
          ],
          error: null,
        },
        { error: null }, // deactivate update
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospTeammateSyncHandler, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ upserted: 1, deactivated: 1 })

    const upsert = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'upsert')
    expect(upsert?.args[1]).toEqual({ onConflict: 'org_id,external_id,external_source', ignoreDuplicates: false })
    expect(upsert?.args[0]).toEqual([
      { org_id: 'org_1', name: 'Jane Cleaner', external_id: 'tm_1', external_source: 'hospitable' },
    ])

    const deactivate = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'update')
    expect(deactivate?.args[0]).toEqual({ is_active: false })
    const deactivateIn = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'in')
    expect(deactivateIn?.args).toEqual(['id', ['crew_gone']])

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        orgId: 'org_1', action: 'crew.member.deactivated', targetType: 'crew_member', targetId: 'crew_gone',
        metadata: { reason: 'removed_from_hospitable' },
      }),
    ])
  })

  it('is a no-op when Hospitable returns no teammates and there are no active crew rows to reconcile against', async () => {
    ;(hospFetchTeammates as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(hospitableTeammatesToCrewRows as ReturnType<typeof vi.fn>).mockReturnValue([])
    const supabase = makeSupabase({
      crew_members: [
        { data: [], error: null }, // no existing active crew
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospTeammateSyncHandler, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ upserted: 0, deactivated: 0 })
    // upsert step short-circuits on an empty rows array — never calls Supabase at all
    expect(supabase.calls.some((c) => c.method === 'upsert')).toBe(false)
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('re-running against the same still-active teammate does not deactivate them — idempotent on unchanged roster', async () => {
    ;(hospFetchTeammates as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'tm_1', name: 'Jane Cleaner' }])
    ;(hospitableTeammatesToCrewRows as ReturnType<typeof vi.fn>).mockReturnValue([
      { org_id: 'org_1', name: 'Jane Cleaner', external_id: 'tm_1', external_source: 'hospitable' },
    ])
    const supabase = makeSupabase({
      crew_members: [
        { error: null },                                                          // upsert
        { data: [{ id: 'crew_active', external_id: 'tm_1' }], error: null },       // still present in fresh fetch
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospTeammateSyncHandler, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ upserted: 1, deactivated: 0 })
    expect(supabase.calls.some((c) => c.table === 'crew_members' && c.method === 'update')).toBe(false)
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('throws when the teammates upsert itself fails, instead of proceeding to deactivation with stale data', async () => {
    ;(hospFetchTeammates as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'tm_1', name: 'Jane Cleaner' }])
    ;(hospitableTeammatesToCrewRows as ReturnType<typeof vi.fn>).mockReturnValue([
      { org_id: 'org_1', name: 'Jane Cleaner', external_id: 'tm_1', external_source: 'hospitable' },
    ])
    const supabase = makeSupabase({
      crew_members: [{ error: { message: 'db unavailable' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(hospTeammateSyncHandler, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })).rejects.toThrow('Teammates upsert failed: db unavailable')
  })
})
