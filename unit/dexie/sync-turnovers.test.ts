import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
}))

import { syncAssignedTurnovers, pullChecklistsForTurnovers } from '@/lib/dexie/sync/turnovers'
import type { DexieSupabaseClient } from '@/lib/dexie/sync/types'

const T1 = {
  id: 't1', property_id: 'p1', org_id: 'org1', checkout_datetime: '2026-07-25T15:00:00Z',
  checkin_datetime: '2026-07-25T19:00:00Z', window_minutes: 240, status: 'assigned',
  priority: 'medium', notes: null, inventory_started_at: null,
  inventory_confirmed_complete_at: null, inventory_confirmed_by_crew_id: null,
  completion_notes: null, pending_checkout_datetime: null, pending_checkin_datetime: null,
  dates_changed_at: null, dates_change_acknowledged_at: null,
  updated_at: '2026-07-24T10:00:00.000Z',
}

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

describe('syncAssignedTurnovers', () => {
  beforeEach(() => {
    holder.db = makeFakeDexieDb()
    vi.clearAllMocks()
  })

  it('first sync (no cursor): full-pulls the assigned scope and seeds the turnover cursor', async () => {
    const supabase = makeFakeSupabase({
      turnover_assignments:     [{ data: [{ turnover_id: 't1' }] }],
      turnovers:                [{ data: [T1] }],
      properties:               [{ data: [{ id: 'p1', org_id: 'org1', name: 'Lake House' }] }],
      inventory_items:          [{ data: [] }],
      checklist_instances:      [{ data: [] }],
      checklist_instance_items: [{ data: [] }],
    })

    await syncAssignedTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    const stored = await db().turnovers.get('t1')
    expect(stored).toBeDefined()
    // updated_at feeds the cursor but must not land in the Dexie row
    expect(stored).not.toHaveProperty('updated_at')

    const cursor = await db().sync_meta.get('cursor:turnovers')
    expect(cursor?.value).toBeDefined()
    expect(String(cursor!.value) < T1.updated_at).toBe(true) // overlap subtracted

    // Full pull — no .gt cursor filter on any turnovers query
    const turnoverGts = supabase.calls.filter((c) => c.table === 'turnovers' && c.method === 'gt')
    expect(turnoverGts).toHaveLength(0)
  })

  it('reconciles deletions: an unassigned turnover and its cached checklists leave the device', async () => {
    await db().turnovers.bulkPut([{ id: 't1', property_id: 'p1' }, { id: 't2', property_id: 'p2' }])
    await db().checklist_instances.bulkPut([{ id: 'ci2', turnover_id: 't2' }])
    await db().checklist_instance_items.bulkPut([{ id: 'item2', turnover_id: 't2', instance_id: 'ci2' }])
    await db().sync_meta.put({ key: 'cursor:turnovers', value: '2026-07-24T09:00:00.000Z' })

    const supabase = makeFakeSupabase({
      turnover_assignments:     [{ data: [{ turnover_id: 't1' }] }], // t2 no longer assigned
      turnovers:                [{ data: [] }],                       // delta: nothing changed
      inventory_items:          [{ data: [] }],
      checklist_instances:      [{ data: [] }],
      checklist_instance_items: [{ data: [] }],
    })

    await syncAssignedTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    expect(await db().turnovers.get('t2')).toBeUndefined()
    expect(await db().checklist_instances.get('ci2')).toBeUndefined()
    expect(await db().checklist_instance_items.get('item2')).toBeUndefined()
    expect(await db().turnovers.get('t1')).toBeDefined() // still assigned — untouched
  })

  it('delta pull: known ids use .gt(updated_at, cursor); an empty delta leaves the cursor unchanged', async () => {
    await db().turnovers.bulkPut([{ id: 't1', property_id: 'p1' }])
    await db().properties.bulkPut([{ id: 'p1' }])
    const cursorValue = '2026-07-24T09:00:00.000Z'
    await db().sync_meta.put({ key: 'cursor:turnovers', value: cursorValue })

    const supabase = makeFakeSupabase({
      turnover_assignments:     [{ data: [{ turnover_id: 't1' }] }],
      turnovers:                [{ data: [] }],
      inventory_items:          [{ data: [] }],
      checklist_instances:      [{ data: [] }],
      checklist_instance_items: [{ data: [] }],
    })

    await syncAssignedTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    const gtCall = supabase.calls.find((c) => c.table === 'turnovers' && c.method === 'gt')
    expect(gtCall?.args).toEqual(['updated_at', cursorValue])
    expect((await db().sync_meta.get('cursor:turnovers'))?.value).toBe(cursorValue)
  })

  it('an id new to the device is pulled WITHOUT the cursor even when one exists', async () => {
    await db().turnovers.bulkPut([{ id: 't1', property_id: 'p1' }])
    await db().properties.bulkPut([{ id: 'p1' }])
    await db().sync_meta.put({ key: 'cursor:turnovers', value: '2026-07-24T09:00:00.000Z' })

    const supabase = makeFakeSupabase({
      turnover_assignments: [{ data: [{ turnover_id: 't1' }, { turnover_id: 't2' }] }],
      turnovers: [
        { data: [{ ...T1, id: 't2', updated_at: '2026-01-01T00:00:00.000Z' }] }, // fresh-id full pull
        { data: [] },                                                            // known-id delta
      ],
      inventory_items:          [{ data: [] }],
      checklist_instances:      [{ data: [] }, { data: [] }],
      checklist_instance_items: [{ data: [] }, { data: [] }],
    })

    await syncAssignedTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    // t2's row is months old (far older than the cursor) but still landed —
    // the fresh-id path bypassed the delta filter
    expect(await db().turnovers.get('t2')).toBeDefined()

    // Exactly one .gt (the known-id delta), and the fresh pull scoped .in to t2
    const turnoverCalls = supabase.calls.filter((c) => c.table === 'turnovers')
    expect(turnoverCalls.filter((c) => c.method === 'gt')).toHaveLength(1)
    const inCalls = turnoverCalls.filter((c) => c.method === 'in')
    expect(inCalls[0]?.args).toEqual(['id', ['t2']])
    expect(inCalls[1]?.args).toEqual(['id', ['t1']])
  })
})

describe('pullChecklistsForTurnovers', () => {
  beforeEach(() => {
    holder.db = makeFakeDexieDb()
    vi.clearAllMocks()
  })

  it("nullifies other crew members' notes before caching (multi-crew privacy)", async () => {
    const supabase = makeFakeSupabase({
      checklist_instances: [{ data: [{ id: 'ci1', turnover_id: 't1', org_id: 'org1', status: 'active', section_photo_path: null, started_at: null, completed_at: null, completed_by_crew_id: null, updated_at: '2026-07-24T10:00:00.000Z' }] }],
      checklist_instance_items: [{
        data: [
          { id: 'i-mine',   instance_id: 'ci1', turnover_id: 't1', section_name: 'Kitchen', task: 'A', is_completed: 1, completed_at: null, completed_by_crew_id: 'crew1', requires_photo: 0, photo_reason: null, photo_storage_path: null, crew_notes: 'my note', sort_order: 1, is_section_final_item: 0, updated_at: '2026-07-24T10:00:00.000Z' },
          { id: 'i-theirs', instance_id: 'ci1', turnover_id: 't1', section_name: 'Kitchen', task: 'B', is_completed: 1, completed_at: null, completed_by_crew_id: 'crew2', requires_photo: 0, photo_reason: null, photo_storage_path: null, crew_notes: 'their note', sort_order: 2, is_section_final_item: 0, updated_at: '2026-07-24T10:00:00.000Z' },
        ],
      }],
    })

    await pullChecklistsForTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', ['t1'], 'crew1')

    expect((await db().checklist_instance_items.get('i-mine'))?.crew_notes).toBe('my note')
    expect((await db().checklist_instance_items.get('i-theirs'))?.crew_notes).toBe('')
  })

  it('partial-scope pulls (Realtime handlers) never advance the checklist cursors', async () => {
    const supabase = makeFakeSupabase({
      checklist_instances:      [{ data: [{ id: 'ci1', turnover_id: 't1', updated_at: '2026-07-24T10:00:00.000Z' }] }],
      checklist_instance_items: [{ data: [] }],
    })

    // 4-arg call — exactly how context.tsx's Realtime handlers invoke it
    await pullChecklistsForTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', ['t1'], 'crew1')

    expect(await db().sync_meta.get('cursor:checklist_instances')).toBeUndefined()
    expect(await db().sync_meta.get('cursor:checklist_items')).toBeUndefined()
  })

  it('full-scope pulls (advanceCursors: true) do advance the checklist cursors', async () => {
    const supabase = makeFakeSupabase({
      checklist_instances:      [{ data: [{ id: 'ci1', turnover_id: 't1', updated_at: '2026-07-24T10:00:00.000Z' }] }],
      checklist_instance_items: [{ data: [{ id: 'i1', instance_id: 'ci1', turnover_id: 't1', is_completed: 0, is_section_final_item: 0, completed_by_crew_id: null, crew_notes: null, photo_reason: null, requires_photo: 0, updated_at: '2026-07-24T10:01:00.000Z' }] }],
    })

    await pullChecklistsForTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', ['t1'], 'crew1', { advanceCursors: true })

    expect(await db().sync_meta.get('cursor:checklist_instances')).toBeDefined()
    expect(await db().sync_meta.get('cursor:checklist_items')).toBeDefined()
  })
})
