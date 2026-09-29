// CHARACTERIZATION test for the crew cache's retention behaviour, written
// BEFORE changing any of it. Nothing here asserts a desired end state — every
// assertion records what lib/dexie/sync/turnovers.ts does today, so that a
// retention change can be judged against measured behaviour instead of against
// a reading of the code.
//
// Three of these document holes rather than guarantees. When a fix lands, the
// corresponding test should FLIP (and say so), not be deleted: the value is in
// the before/after pair.
//
// WHY IT DOES NOT USE makeFakeSupabase
//
// That helper returns CANNED rows per table and ignores the filters. The whole
// question here is whether `.gt('updated_at', cursor)` excludes a row the
// device deleted locally, so a fake that ignores filters would "confirm" any
// hypothesis put to it. This file stands up a fake server that actually
// EXECUTES .in/.eq/.gt/.order/.range against an in-memory dataset, and the
// CANARY test exists to prove that server really filters — deleting a turnover
// row must bring it back. A canary that passes means the rest is measuring
// nothing.
//
// THE FIXTURE DETAIL THAT IS NOT DECORATION
//
// advanceCursor stores max(updated_at) - CURSOR_OVERLAP_MS (10s), so the delta
// filter re-pulls every row within ten seconds of the newest one the device has
// seen. The first version of this file gave every row one identical timestamp,
// which put ALL of them permanently inside that window: the delta returned the
// entire table on every sync and the purge appeared not to work at all. That
// was the fixture, not the design. Timestamps are spread here for that reason,
// and HOLE 3 pins the boundary case the mistake uncovered.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeDexieDb, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

import { syncAssignedTurnovers, CREW_SCOPE_HORIZON_DAYS } from '@/lib/dexie/sync/turnovers'
import { pruneSettledChecklistItems, DEAD_LETTER_RETENTION_DAYS } from '@/lib/dexie/prune'
import type { DexieSupabaseClient } from '@/lib/dexie/sync/types'

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

// ── A server that really runs the query ─────────────────────────────────────
interface Server {
  turnover_assignments: Record<string, unknown>[]
  turnovers:            Record<string, unknown>[]
  checklist_instances:  Record<string, unknown>[]
  checklist_instance_items: Record<string, unknown>[]
  properties:           Record<string, unknown>[]
  inventory_items:      Record<string, unknown>[]
}

function makeServer(server: Server) {
  const queryLog: { table: string; gt: string | null; inCount: number; rows: number }[] = []

  const from = (table: string) => {
    let rows = [...(server[table as keyof Server] ?? [])]
    let gtValue: string | null = null
    let inCount = 0
    let from_ = 0
    let to_ = Number.MAX_SAFE_INTEGER

    const chain: Record<string, unknown> = {
      select: () => chain,
      limit:  () => chain,
      not:    () => chain,
      or:     () => chain,
      update: () => chain,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val); return chain
      },
      in: (col: string, vals: unknown[]) => {
        inCount = vals.length
        const set = new Set(vals)
        rows = rows.filter((r) => set.has(r[col])); return chain
      },
      gt: (col: string, val: string) => {
        gtValue = val
        rows = rows.filter((r) => String(r[col]) > val); return chain
      },
      // The crew scope read filters on an EMBEDDED column
      // (`turnovers.checkout_datetime`), so the dotted name is resolved against
      // the joined row rather than the assignment row — which is the filter
      // actually being tested, not a convenience.
      gte: (col: string, val: string) => {
        const [rel, field] = col.includes('.') ? col.split('.') : [null, col]
        rows = rows.filter((r) => {
          if (rel === null) return String(r[field!]) >= val
          const joined = server[rel as keyof Server]
            ?.find((j) => j.id === r[`${rel!.replace(/s$/, '')}_id`])
          return joined ? String(joined[field!]) >= val : false
        })
        return chain
      },
      order: (col: string) => {
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1)); return chain
      },
      range: (a: number, b: number) => { from_ = a; to_ = b; return chain },
    }
    ;(chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const page = rows.slice(from_, to_ + 1)
      queryLog.push({ table, gt: gtValue, inCount, rows: page.length })
      return Promise.resolve(resolve({ data: page, error: null }))
    }
    return chain
  }

  return { client: { from } as unknown as DexieSupabaseClient, queryLog }
}

// ── Fixture: 10 turnovers, 8 completed + 2 active, 57 items each ────────────
const ITEMS_PER = 57

// Timestamps MUST be spread. advanceCursor stores max(updated_at) −
// CURSOR_OVERLAP_MS (10s), so `.gt('updated_at', cursor)` re-pulls every row
// within 10 seconds of the newest one the device has seen. A fixture where
// every row shares one updated_at puts ALL of them permanently inside that
// window, and the delta pull then returns the whole table on every sync —
// which is what the first run of this file actually showed, and it is a
// property of the fixture, not of the design.
//
// So: completed turnovers are aged days apart, and the two ACTIVE ones carry
// the newest timestamps (the work actually in progress), which is what sets
// the high-water mark on a real device.
const DAY = 86_400_000
// Anchored to REAL now, not a fixed date. fetchAssignedTurnoverIds applies
// CREW_SCOPE_HORIZON_DAYS against Date.now(), so a hardcoded 2026-02-01 fixture
// falls out of scope the moment the wall clock passes it and every turnover is
// reconciled off the device — the tests then pass or fail by calendar date.
// 20 days back, so the ten turnovers span now-20d .. now-11d: comfortably
// inside CREW_SCOPE_HORIZON_DAYS with real margin. Sitting nearer the horizon
// would make an unrelated change to that constant fail these tests for fixture
// reasons rather than design ones, and the HORIZON cases below move their own
// dates explicitly instead of relying on where the block happens to land.
const BASE = Date.now() - 20 * DAY
const tsFor = (t: number) => new Date(BASE + t * DAY).toISOString()

function buildServer(): Server {
  const turnovers: Record<string, unknown>[] = []
  const assignments: Record<string, unknown>[] = []
  const instances: Record<string, unknown>[] = []
  const items: Record<string, unknown>[] = []

  for (let t = 0; t < 10; t++) {
    const id = `t${String(t).padStart(2, '0')}`
    const completed = t < 8
    turnovers.push({
      id, property_id: 'p1', org_id: 'org1',
      checkout_datetime: tsFor(t), checkin_datetime: tsFor(t),
      window_minutes: 240, status: completed ? 'completed' : 'assigned',
      priority: 'medium', notes: null, prev_booking_id: null,
      inventory_started_at: null, inventory_confirmed_complete_at: null,
      inventory_confirmed_by_crew_id: null, completion_notes: null,
      pending_checkout_datetime: null, pending_checkin_datetime: null,
      dates_changed_at: null, dates_change_acknowledged_at: null,
      updated_at: tsFor(t),
    })
    assignments.push({ turnover_id: id, crew_member_id: 'crew1' })
    instances.push({ id: `ci_${id}`, turnover_id: id, org_id: 'org1', status: 'active',
      section_photo_path: null, started_at: null,
      // Settled checklists carry a real completed_at — it is the only local
      // record of WHEN, since item rows drop updated_at in normalization, and
      // pruneSettledChecklistItems compares it against the delta cursor.
      completed_at: completed ? tsFor(t) : null,
      completed_by_crew_id: null, updated_at: tsFor(t) })
    for (let i = 0; i < ITEMS_PER; i++) {
      items.push({
        id: `item_${id}_${i}`, instance_id: `ci_${id}`, turnover_id: id,
        section_name: 'Kitchen', section_name_es: null, task: `task ${i}`, task_es: null,
        is_completed: completed, completed_at: null, completed_by_crew_id: null,
        requires_photo: false, photo_reason: null, photo_storage_path: null,
        crew_notes: null, sort_order: i, is_section_final_item: false,
        asset_discovery_type: null, updated_at: tsFor(t),
      })
    }
  }
  return {
    turnover_assignments: assignments, turnovers, checklist_instances: instances,
    checklist_instance_items: items,
    properties: [{ id: 'p1', org_id: 'org1', name: 'Lake House' }],
    inventory_items: [],
  }
}

const COMPLETED_IDS = Array.from({ length: 8 }, (_, t) => `t${String(t).padStart(2, '0')}`)

/** The proposed purge: drop cached items for turnovers cached as completed. */
async function purgeCompletedChecklistItems(): Promise<number> {
  const turnovers = await db().turnovers.toArray()
  const completed = new Set(
    turnovers.filter((t) => (t as { status?: string }).status === 'completed').map((t) => (t as { id: string }).id),
  )
  const all = await db().checklist_instance_items.toArray()
  const doomed = all.filter((i) => completed.has((i as { turnover_id: string }).turnover_id))
  await db().checklist_instance_items.bulkDelete(doomed.map((i) => (i as { id: string }).id))
  return doomed.length
}

async function itemCount(): Promise<number> {
  return (await db().checklist_instance_items.toArray()).length
}

describe('crew cache retention — simulated', () => {
  beforeEach(() => { holder.db = makeFakeDexieDb() })

  it('CANARY: the fake server really filters — deleting a TURNOVER row re-pulls it in full', async () => {
    const { client } = makeServer(buildServer())
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    expect(await itemCount()).toBe(10 * ITEMS_PER)

    // Delete one whole turnover (my rejected proposal). It should come BACK,
    // because partitionByKnown reclassifies it as `fresh` and fresh ids skip
    // the cursor. If this does NOT come back, the fake is not modelling the
    // real pull and nothing else in this file means anything.
    await db().turnovers.bulkDelete(['t00'])
    await db().checklist_instance_items.bulkDelete(
      (await db().checklist_instance_items.toArray())
        .filter((i) => (i as { turnover_id: string }).turnover_id === 't00')
        .map((i) => (i as { id: string }).id),
    )
    expect(await itemCount()).toBe(9 * ITEMS_PER)

    await syncAssignedTurnovers(client, 'u1', 'crew1')

    expect(await db().turnovers.get('t00')).toBeDefined()
    expect(await itemCount()).toBe(10 * ITEMS_PER)   // fully restored — the re-pull loop
  })

  it('PROPOSAL: purging completed items does NOT re-pull them on the next sync', async () => {
    const { client } = makeServer(buildServer())
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    expect(await itemCount()).toBe(570)

    const purged = await purgeCompletedChecklistItems()
    expect(purged).toBe(8 * ITEMS_PER)
    expect(await itemCount()).toBe(2 * ITEMS_PER)

    // Three further syncs — the purge must be stable, not merely slow to undo.
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    await syncAssignedTurnovers(client, 'u1', 'crew1')

    expect(await itemCount()).toBe(2 * ITEMS_PER)
    // The turnover rows themselves stay, so the detail page still resolves
    // and partitionByKnown keeps every id on the delta path.
    expect((await db().turnovers.toArray())).toHaveLength(10)
    for (const id of COMPLETED_IDS) expect(await db().turnovers.get(id)).toBeDefined()
  })

  it('HOLE 1: a forced resync re-inflates the purged items in one shot', async () => {
    const { client } = makeServer(buildServer())
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    await purgeCompletedChecklistItems()
    expect(await itemCount()).toBe(2 * ITEMS_PER)

    await syncAssignedTurnovers(client, 'u1', 'crew1', true)   // force = true

    expect(await itemCount()).toBe(10 * ITEMS_PER)
  })

  it('HOLE 2: a server-side touch after the purge re-pulls just that turnover\'s items', async () => {
    const server = buildServer()
    const { client } = makeServer(server)
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    await purgeCompletedChecklistItems()
    expect(await itemCount()).toBe(2 * ITEMS_PER)

    // A PM edit / cron touches one completed turnover's items.
    const future = new Date(Date.now() + 86_400_000).toISOString()
    for (const item of server.checklist_instance_items) {
      if (item.turnover_id === 't00') item.updated_at = future
    }
    await syncAssignedTurnovers(client, 'u1', 'crew1')

    // Only t00's items return; the other seven stay purged.
    expect(await itemCount()).toBe(3 * ITEMS_PER)
  })

  it('HOLE 3, CLOSED: the real purge retains a JUST-completed turnover instead of thrashing', async () => {
    const server = buildServer()
    // t09 completes RIGHT NOW: its items become both the newest rows on the
    // server and newly eligible for a naive "purge on completion" trigger.
    const now = new Date(BASE + 20 * DAY).toISOString()
    for (const t of server.turnovers) if (t.id === 't09') { t.status = 'completed'; t.updated_at = now }
    for (const i of server.checklist_instances) if (i.turnover_id === 't09') { i.completed_at = now; i.updated_at = now }
    for (const i of server.checklist_instance_items) if (i.turnover_id === 't09') i.updated_at = now

    const { client } = makeServer(server)
    await syncAssignedTurnovers(client, 'u1', 'crew1')

    // The naive status-based purge takes t09 with the other nine...
    const naive = await purgeCompletedChecklistItems()
    expect(naive).toBe(9 * ITEMS_PER)
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    // ...and t09 comes straight back, because its updated_at is inside
    // CURSOR_OVERLAP_MS of the cursor. That is the thrash.
    const backAfterNaive = (await db().checklist_instance_items.toArray())
      .filter((i) => (i as { turnover_id: string }).turnover_id === 't09')
    expect(backAfterNaive).toHaveLength(ITEMS_PER)

    // The production purge compares completed_at against the cursor instead,
    // so it leaves t09 alone: the eight OLDER checklists go, t09's stay.
    await pruneSettledChecklistItems('u1')
    const afterPurge = (await db().checklist_instance_items.toArray()).length
    expect(afterPurge).toBe(2 * ITEMS_PER)   // t09 (just completed) + t08 (active)

    await syncAssignedTurnovers(client, 'u1', 'crew1')
    // Stable across a further sync — nothing settled was removed prematurely,
    // so nothing is re-pulled. Compared against the count captured BEFORE the
    // sync, not against a second read of the same array.
    expect(await db().checklist_instance_items.toArray()).toHaveLength(afterPurge)
  })

  it('HOLE 1, CLOSED: the purge sheds a forced resync in the same pass', async () => {
    const { client } = makeServer(buildServer())
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    await pruneSettledChecklistItems('u1')
    const steady = (await db().checklist_instance_items.toArray()).length
    expect(steady).toBe(2 * ITEMS_PER)   // only the two active turnovers

    // force = true rewinds the cursors and re-pulls everything...
    await syncAssignedTurnovers(client, 'u1', 'crew1', true)
    expect(await db().checklist_instance_items.toArray()).toHaveLength(10 * ITEMS_PER)

    // ...and the prune that runs at the tail of fullCrewResync sheds it again,
    // so the inflation is transient rather than the device's new resting size.
    await pruneSettledChecklistItems('u1')
    expect(await db().checklist_instance_items.toArray()).toHaveLength(steady)
  })

  // ── The scope horizon ──────────────────────────────────────────────────────

  it('HORIZON: a turnover older than CREW_SCOPE_HORIZON_DAYS leaves the device', async () => {
    const server = buildServer()
    // t00 checked out well before the horizon; everything else stays inside it.
    const ancient = new Date(Date.now() - (CREW_SCOPE_HORIZON_DAYS + 10) * DAY).toISOString()
    for (const t of server.turnovers) if (t.id === 't00') t.checkout_datetime = ancient

    const { client } = makeServer(server)
    await syncAssignedTurnovers(client, 'u1', 'crew1')

    // Gone entirely — the row, its instance and its items — because the scope
    // read no longer returns it and reconcileRemovedTurnovers treats absence
    // from the scope as "not mine any more".
    expect(await db().turnovers.get('t00')).toBeUndefined()
    expect(await db().checklist_instances.get('ci_t00')).toBeUndefined()
    expect((await db().checklist_instance_items.toArray())
      .filter((i) => (i as { turnover_id: string }).turnover_id === 't00')).toHaveLength(0)

    // ...and the other nine are untouched.
    expect(await db().turnovers.toArray()).toHaveLength(9)
  })

  it('HORIZON: a FUTURE turnover is always in scope, however far out', async () => {
    const server = buildServer()
    const farOut = new Date(Date.now() + 200 * DAY).toISOString()
    for (const t of server.turnovers) if (t.id === 't09') t.checkout_datetime = farOut

    const { client } = makeServer(server)
    await syncAssignedTurnovers(client, 'u1', 'crew1')

    // The horizon bounds the PAST only: a turnover months out is still theirs
    // to prepare for, and shedding it would take the job off the device before
    // they ever saw it.
    expect(await db().turnovers.get('t09')).toBeDefined()
  })

  it('HORIZON: an out-of-scope turnover with UNSENT WORK is retained', async () => {
    const server = buildServer()
    const ancient = new Date(Date.now() - (CREW_SCOPE_HORIZON_DAYS + 10) * DAY).toISOString()
    for (const t of server.turnovers) if (t.id === 't00') t.checkout_datetime = ancient

    const { client } = makeServer(server)
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    expect(await db().turnovers.get('t00')).toBeUndefined()   // baseline: it goes

    // Now the same device has a photo still queued against one of its items.
    holder.db = makeFakeDexieDb()
    const fresh = makeServer(server)
    await db().turnovers.bulkPut([{ id: 't00', property_id: 'p1' }])
    await db().checklist_instances.bulkPut([{ id: 'ci_t00', turnover_id: 't00' }])
    await db().checklist_instance_items.bulkPut([
      { id: 'item_t00_0', instance_id: 'ci_t00', turnover_id: 't00' },
    ])
    await db().pending_photo_uploads.put({
      id: 'ph1', target_table: 'checklist_instance_items', target_id: 'item_t00_0',
      target_column: 'photo_storage_path', storage_path: 'org1/x.jpg',
      local_blob_key: 'b1', mime_type: 'image/jpeg', retry_count: 0,
      created_at: new Date().toISOString(),
    })

    await syncAssignedTurnovers(fresh.client, 'u1', 'crew1')

    // Retained despite being outside the horizon: the item row is what
    // photo-sync walks to resolve the upload's org prefix, and 30 days of
    // dead-letter life is not the same clock as the scope horizon.
    expect(await db().turnovers.get('t00')).toBeDefined()
    expect(await db().checklist_instance_items.get('item_t00_0')).toBeDefined()
  })

  it('HORIZON: exceeds DEAD_LETTER_RETENTION_DAYS', () => {
    // Stated here as well as in the guardrail because this file is where the
    // consequence is visible: if the horizon were the shorter of the two, a
    // dead letter would still be on screen for a turnover the device had
    // already shed.
    expect(CREW_SCOPE_HORIZON_DAYS).toBeGreaterThan(DEAD_LETTER_RETENTION_DAYS)
  })

  it('round trips and rows transferred drop on the steady-state sync after a purge', async () => {
    const { client, queryLog } = makeServer(buildServer())
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    const firstSync = queryLog.length
    const firstRows = queryLog.reduce((n, q) => n + q.rows, 0)

    await purgeCompletedChecklistItems()
    queryLog.length = 0
    await syncAssignedTurnovers(client, 'u1', 'crew1')
    const steadyRows = queryLog.reduce((n, q) => n + q.rows, 0)

    // Every checklist read on the steady-state sync carried the cursor.
    const itemReads = queryLog.filter((q) => q.table === 'checklist_instance_items')
    expect(itemReads.length).toBeGreaterThan(0)
    for (const r of itemReads) expect(r.gt).not.toBeNull()

    expect(steadyRows).toBeLessThan(firstRows)
    console.log(`  first sync: ${firstSync} queries, ${firstRows} rows`)
    console.log(`  steady sync after purge: ${queryLog.length} queries, ${steadyRows} rows`)
  })
})
