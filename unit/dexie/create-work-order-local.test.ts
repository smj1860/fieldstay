import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDashboardDb, getDashboardDb } from '@/lib/dexie/dashboard/schema'

// ============================================================================
// A WORK ORDER RAISED AT A PROPERTY WITH NO SIGNAL.
//
// §8 allows this and forbids its opposite, for a reason worth restating: a
// CREATE is safe because the row is new and nobody else can be holding a
// different version of it, whereas editing an existing work order offline means
// last-write-wins across a six-hour gap on a board a second PM and the vendor
// portal can both touch.
//
// The property under test is atomicity. The optimistic row and its outbox entry
// commit together or not at all — as two transactions, a PWA reclaimed between
// them leaves the board showing a work order with nothing queued to send it,
// and no delta pull corrects that because the server row never existed.
// ============================================================================

const USER = '11111111-2222-3333-4444-555555555555'
const ORG  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const { createWorkOrderLocal } = await import('@/lib/dexie/dashboard/create-work-order-local')

const input = (over: Record<string, unknown> = {}) => ({
  propertyId:           'prop-1',
  title:                'Back door latch does not engage',
  description:          'Sticks in the cold',
  priority:             'high' as const,
  category:             'general' as const,
  assetId:              null,
  assignedCrewMemberId: null,
  vendorId:             null,
  scheduledDate:        null,
  ...over,
})

beforeEach(async () => {
  vi.stubGlobal('navigator', { onLine: false })
  closeDashboardDb()
  const db = getDashboardDb(USER, ORG)
  await db.open()
  await Promise.all([db.work_orders.clear(), db.mutations.clear()])
})

describe('createWorkOrderLocal', () => {
  it('writes the board row and the outbox entry together', async () => {
    const result = await createWorkOrderLocal(USER, ORG, input())
    expect(result.ok).toBe(true)

    const db = getDashboardDb(USER, ORG)
    const row = await db.work_orders.get(result.id!)
    expect(row).toMatchObject({
      id: result.id, org_id: ORG, property_id: 'prop-1', source: 'manual',
      title: 'Back door latch does not engage',
    })

    const queued = await db.mutations.toArray()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ kind: 'work_order.create', targetId: result.id, failed: 0 })
  })

  it('queues the SAME id it wrote locally', async () => {
    // The device mints it precisely so the optimistic row and the eventual
    // server row are one row, and so the route's upsert can recognise a replay.
    // Two ids here would mean reconciling two identities later.
    const result = await createWorkOrderLocal(USER, ORG, input())
    const db = getDashboardDb(USER, ORG)
    const queued = (await db.mutations.toArray())[0]!
    expect((queued.payload as { id: string }).id).toBe(result.id)
    expect(await db.work_orders.get(result.id!)).toBeTruthy()
  })

  it('leaves wo_number unset — the server assigns it', async () => {
    // assign_wo_number is a per-org sequential trigger. A device that guessed
    // one would risk two work orders claiming the same number, and the number
    // is what a PM says out loud to a vendor.
    const result = await createWorkOrderLocal(USER, ORG, input())
    const row = await getDashboardDb(USER, ORG).work_orders.get(result.id!)
    expect(row!.wo_number).toBeNull()
  })

  it('derives the same status the server will', async () => {
    // The board must not flicker: a row that renders "Pending" offline and
    // "Assigned" after the sync reads as the sync having changed something.
    const unassigned = await createWorkOrderLocal(USER, ORG, input())
    const assigned   = await createWorkOrderLocal(USER, ORG, input({ vendorId: 'vendor-1' }))

    const db = getDashboardDb(USER, ORG)
    expect((await db.work_orders.get(unassigned.id!))!.status).toBe('pending')
    expect((await db.work_orders.get(assigned.id!))!.status).toBe('assigned')
  })

  it('refuses an empty title before anything is written', async () => {
    // Caught here as well as at the boundary because the failure modes differ:
    // the route's rejection reaches the PM through the sync banner minutes
    // later, this one while they are still looking at the field.
    const result = await createWorkOrderLocal(USER, ORG, input({ title: '   ' }))
    expect(result.ok).toBe(false)

    const db = getDashboardDb(USER, ORG)
    expect(await db.work_orders.count()).toBe(0)
    expect(await db.mutations.count()).toBe(0)
  })

  it('refuses a missing property before anything is written', async () => {
    const result = await createWorkOrderLocal(USER, ORG, input({ propertyId: '' }))
    expect(result.ok).toBe(false)
    expect(await getDashboardDb(USER, ORG).mutations.count()).toBe(0)
  })

  it('two work orders raised on one visit do not collide', async () => {
    const a = await createWorkOrderLocal(USER, ORG, input({ title: 'Handrail' }))
    const b = await createWorkOrderLocal(USER, ORG, input({ title: 'Gutter' }))

    expect(a.id).not.toBe(b.id)
    expect(await getDashboardDb(USER, ORG).mutations.count()).toBe(2)
  })

  it('trims the title, so the board and the work order agree', async () => {
    const result = await createWorkOrderLocal(USER, ORG, input({ title: '  Gutter blocked  ' }))
    const db = getDashboardDb(USER, ORG)
    expect((await db.work_orders.get(result.id!))!.title).toBe('Gutter blocked')
    expect((await db.mutations.toArray())[0]!.payload).toMatchObject({ title: 'Gutter blocked' })
  })
})
