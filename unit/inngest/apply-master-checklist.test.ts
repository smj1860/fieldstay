import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/checklists/seed-default-room-templates', () => ({
  seedDefaultRoomTemplatesIfNeeded: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/checklists/apply-master-template', () => ({
  fetchOrgRoomTemplateData:  vi.fn(),
  applyMasterChecklistToProperty: vi.fn().mockResolvedValue(undefined),
}))

import { applyMasterChecklistJob } from '@/lib/inngest/functions/apply-master-checklist'
import { createServiceClient } from '@/lib/supabase/server'
import { seedDefaultRoomTemplatesIfNeeded } from '@/lib/checklists/seed-default-room-templates'
import { fetchOrgRoomTemplateData, applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import type { OrgRoomTemplateData } from '@/lib/checklists/apply-master-template'
import { invokeHandler } from './test-helpers'

function makeSupabase(ownedIdsByCall: string[][]) {
  let call = 0
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.then   = (resolve: (v: unknown) => unknown) => {
      const ids = ownedIdsByCall[call] ?? []
      call += 1
      return Promise.resolve({ data: ids.map((id) => ({ id })), error: null }).then(resolve)
    }
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const ROOM_DATA = { rooms: [] } as unknown as OrgRoomTemplateData

describe('applyMasterChecklistJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(fetchOrgRoomTemplateData as ReturnType<typeof vi.fn>).mockResolvedValue(ROOM_DATA)
  })

  it('applies the master checklist to every owned property in a single batch', async () => {
    const supabase = makeSupabase([['prop_1', 'prop_2']])
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(applyMasterChecklistJob, {
      event: { data: { org_id: 'org_1', property_ids: ['prop_1', 'prop_2'], triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ applied: 2 })
    expect(seedDefaultRoomTemplatesIfNeeded).toHaveBeenCalledWith('org_1')
    expect(applyMasterChecklistToProperty).toHaveBeenCalledTimes(2)
    expect(applyMasterChecklistToProperty).toHaveBeenCalledWith(
      'prop_1', 'org_1', supabase,
      { force: true, actorId: 'user_1', orgRoomData: ROOM_DATA, skipSeed: true },
    )
    expect(applyMasterChecklistToProperty).toHaveBeenCalledWith(
      'prop_2', 'org_1', supabase,
      { force: true, actorId: 'user_1', orgRoomData: ROOM_DATA, skipSeed: true },
    )
  })

  it('is a no-op when property_ids is empty — no ownership query, no apply calls', async () => {
    const supabase = makeSupabase([])
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(applyMasterChecklistJob, {
      event: { data: { org_id: 'org_1', property_ids: [], triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ applied: 0 })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(applyMasterChecklistToProperty).not.toHaveBeenCalled()
  })

  it('IDOR guard: skips a property id that does not belong to the org and excludes it from the applied count', async () => {
    // Requested 2 properties, but the ownership query only returns prop_1 —
    // prop_evil belongs to a different org and must never be touched.
    const supabase = makeSupabase([['prop_1']])
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await invokeHandler(applyMasterChecklistJob, {
      event: { data: { org_id: 'org_1', property_ids: ['prop_1', 'prop_evil'], triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ applied: 1 })
    expect(applyMasterChecklistToProperty).toHaveBeenCalledTimes(1)
    expect(applyMasterChecklistToProperty).toHaveBeenCalledWith(
      'prop_1', 'org_1', supabase, expect.anything(),
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prop_evil'))
    warnSpy.mockRestore()
  })

  it('batches ownership checks in groups of 10 properties', async () => {
    const propertyIds = Array.from({ length: 12 }, (_, i) => `prop_${i + 1}`)
    const supabase = makeSupabase([propertyIds.slice(0, 10), propertyIds.slice(10)])
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(applyMasterChecklistJob, {
      event: { data: { org_id: 'org_1', property_ids: propertyIds, triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ applied: 12 })
    const ownershipQueries = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'in')
    expect(ownershipQueries).toHaveLength(2)
    expect(ownershipQueries[0]?.args[1]).toHaveLength(10)
    expect(ownershipQueries[1]?.args[1]).toHaveLength(2)
    expect(applyMasterChecklistToProperty).toHaveBeenCalledTimes(12)
  })

  it('fetches room template data only once for the whole batch, not per property', async () => {
    const supabase = makeSupabase([['prop_1', 'prop_2']])
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(applyMasterChecklistJob, {
      event: { data: { org_id: 'org_1', property_ids: ['prop_1', 'prop_2'], triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(fetchOrgRoomTemplateData).toHaveBeenCalledTimes(1)
  })
})
