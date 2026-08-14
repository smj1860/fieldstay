import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

import { syncAssignedTurnovers } from '@/lib/dexie/sync/turnovers'
import type { DexieSupabaseClient } from '@/lib/dexie/sync/types'

// ============================================================================
// END-TO-END: an assigned turnover must reach the crew member's home screen.
//
// Reproduces a live report — a crew member assigned to a turnover six days out
// saw an empty "Upcoming". The whole chain is exercised against the ACTUAL
// production row shapes, including the two details a hand-written fixture gets
// wrong and which are the only plausible silent failures here:
//
//   1. PostgREST renders timestamptz as '2026-08-20T15:00:00+00:00', with an
//      offset suffix. app/crew/page.tsx compares that STRING against
//      `${today}T00:00:00` — a lexical comparison, not a date one.
//   2. The assignment scope drives deletion. If fetchAssignedTurnoverIds
//      returns empty, syncAssignedTurnovers returns early AND
//      reconcileRemovedTurnovers has already wiped the cache.
// ============================================================================

/** The crew home page's filter, copied verbatim from app/crew/page.tsx. */
function crewHomeVisible(
  rows: { checkout_datetime: string; status: string }[],
  today: string,
  weekOut: string,
) {
  return rows.filter((t) =>
    t.checkout_datetime >= today + 'T00:00:00' &&
    t.checkout_datetime <= weekOut + 'T23:59:59' &&
    t.status !== 'completed' &&
    t.status !== 'cancelled'
  )
}

/** Exactly what PostgREST returns for public.turnovers — offset suffix included. */
const AUG20 = {
  id: '7624e309-c9b9-4aa1-9ec4-4ab74dbb94c9',
  property_id: 'bigmoose', org_id: 'org1',
  prev_booking_id: 'bk-outgoing',
  checkout_datetime: '2026-08-20T15:00:00+00:00',
  checkin_datetime:  '2026-08-22T19:00:00+00:00',
  window_minutes: 3120, status: 'assigned', priority: 'medium', notes: null,
  inventory_started_at: null, inventory_confirmed_complete_at: null,
  inventory_confirmed_by_crew_id: null, completion_notes: null,
  pending_checkout_datetime: null, pending_checkin_datetime: null,
  dates_changed_at: null, dates_change_acknowledged_at: null,
  updated_at: '2026-08-13T10:00:00.000Z',
}

/** The standalone one, 12 days out — outside the home page's 7-day horizon. */
const AUG26 = {
  ...AUG20,
  id: 'a848698a-26bf-498c-bc7c-78eed379137d',
  prev_booking_id: null,
  checkout_datetime: '2026-08-26T15:00:00+00:00',
  checkin_datetime:  '2026-08-26T19:00:00+00:00',
  window_minutes: 240,
}

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

const TODAY    = '2026-08-14'
const WEEK_OUT = '2026-08-21'

describe('an assigned turnover reaches the crew home screen', () => {
  beforeEach(() => {
    holder.db = makeFakeDexieDb()
    vi.clearAllMocks()
  })

  it('syncs both assigned turnovers onto the device', async () => {
    const supabase = makeFakeSupabase({
      turnover_assignments: [{ data: [{ turnover_id: AUG20.id }, { turnover_id: AUG26.id }] }],
      turnovers:            [{ data: [AUG20, AUG26] }],
      properties:           [{ data: [{ id: 'bigmoose', org_id: 'org1', name: 'The Big Moose Lodge' }] }],
      inventory_items:      [{ data: [] }],
      checklist_instances:  [{ data: [] }],
      checklist_instance_items: [{ data: [] }],
    })

    await syncAssignedTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    expect(await db().turnovers.get(AUG20.id)).toBeDefined()
    expect(await db().turnovers.get(AUG26.id)).toBeDefined()
  })

  it('the synced Aug 20 row passes the home screen filter', async () => {
    // The end-to-end assertion: sync it, then run the page's own predicate over
    // what actually landed, with the offset-suffixed timestamp intact.
    const supabase = makeFakeSupabase({
      turnover_assignments: [{ data: [{ turnover_id: AUG20.id }, { turnover_id: AUG26.id }] }],
      turnovers:            [{ data: [AUG20, AUG26] }],
      properties:           [{ data: [{ id: 'bigmoose', org_id: 'org1', name: 'The Big Moose Lodge' }] }],
      inventory_items:      [{ data: [] }],
      checklist_instances:  [{ data: [] }],
      checklist_instance_items: [{ data: [] }],
    })

    await syncAssignedTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    const cached  = await db().turnovers.toArray()
    const visible = crewHomeVisible(cached as { checkout_datetime: string; status: string }[], TODAY, WEEK_OUT)

    expect(visible.map((t) => (t as unknown as { id: string }).id)).toEqual([AUG20.id])
  })

  it('the offset-suffixed timestamp compares correctly against the window bounds', () => {
    // Isolates detail 1. '+00:00' sorts after 'T23:59:59' at the same second,
    // so a checkout at exactly the upper bound would fall out — worth pinning
    // even though neither fixture sits on the boundary.
    expect(crewHomeVisible([AUG20], TODAY, WEEK_OUT)).toHaveLength(1)
    expect(crewHomeVisible([AUG26], TODAY, WEEK_OUT)).toHaveLength(0)
  })

  it('an empty assignment scope wipes the cache — the failure mode to rule out', async () => {
    // Isolates detail 2, and documents why an empty turnover_assignments read
    // is not a benign no-op: the device is cleared before the early return.
    await db().turnovers.bulkPut([AUG20])

    const supabase = makeFakeSupabase({ turnover_assignments: [{ data: [] }] })
    await syncAssignedTurnovers(supabase as unknown as DexieSupabaseClient, 'u1', 'crew1')

    expect(await db().turnovers.toArray()).toHaveLength(0)
  })
})
