import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/helpers', () => ({ createPmNotification: vi.fn() }))

import {
  acceptWorkOrder,
  declineWorkOrder,
  setVendorProgress,
  vendorDispatchFields,
} from '@/lib/work-orders/vendor-response'
import { createPmNotification } from '@/lib/inngest/helpers'
import type { PortalWorkOrder, PortalPrincipal } from '@/lib/work-orders/portal-token'

type Resp = { data?: unknown; error?: unknown }

/**
 * Records every table, method and payload so the tests can assert on the
 * FILTERS as well as the values. The filters are the concurrency guard here —
 * an unfiltered update would let a second tab, or a technician and the vendor
 * acting at once, overwrite an appointment that was already agreed — so a test
 * that only checked the written values would pass on a broken claim.
 */
function makeSupabase(byTable: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    const q = byTable[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'in', 'not', 'is']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ table, method: m, args }); return chain })
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, calls }
}

const WO: PortalWorkOrder = {
  id: 'wo_1', org_id: 'org_1', property_id: 'prop_1', vendor_id: 'vend_1',
  wo_number: 'WO-1042', title: 'Leaking faucet', category: 'plumbing',
  status: 'assigned', portal_enabled: true, completion_token_expires_at: null,
  needed_by_date: '2026-10-17', vendor_scheduled_at: null, vendor_scheduled_window: null,
  vendor_progress: null, vendor_accepted_at: null, nte_amount: 500,
}

const VENDOR: PortalPrincipal = { kind: 'vendor', grantId: null, displayName: null }
const TECH: PortalPrincipal = { kind: 'technician', grantId: 'grant_1', displayName: 'Mike' }

/** The payload of the first `update` against work_orders. */
function updatePayload(calls: { table: string; method: string; args: unknown[] }[]) {
  return calls.find((c) => c.table === 'work_orders' && c.method === 'update')?.args[0] as Record<string, unknown>
}

beforeEach(() => vi.clearAllMocks())

describe('acceptWorkOrder', () => {
  it('writes the appointment and the derived status in one claim', async () => {
    const { client, calls } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1', status: 'assigned' }], error: null }] })
    const res = await acceptWorkOrder(client, WO, VENDOR, { scheduledAt: '2026-10-15T14:00:00.000Z', window: 'afternoon' })

    expect(res).toEqual({ ok: true, value: { afterNeededBy: false } })

    const payload = updatePayload(calls)
    expect(payload).toMatchObject({
      status:                  'assigned',
      vendor_progress:         'appointment_scheduled',
      vendor_scheduled_at:     '2026-10-15T14:00:00.000Z',
      vendor_scheduled_window: 'afternoon',
    })
    // A re-dispatched work order must not read as both accepted and declined.
    expect(payload.vendor_declined_at).toBeNull()
    expect(payload.vendor_decline_reason).toBeNull()
  })

  it('claims only a still-open work order assigned to this vendor', async () => {
    const { client, calls } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
    await acceptWorkOrder(client, WO, VENDOR, { scheduledAt: '2026-10-15T14:00:00.000Z', window: 'exact' })

    const eqs = calls.filter((c) => c.table === 'work_orders' && c.method === 'eq').map((c) => c.args)
    expect(eqs).toEqual(expect.arrayContaining([
      ['id', 'wo_1'], ['org_id', 'org_1'], ['vendor_id', 'vend_1'],
    ]))
    const ins = calls.find((c) => c.table === 'work_orders' && c.method === 'in')
    expect(ins?.args).toEqual(['status', ['pending', 'assigned', 'quote_requested']])
  })

  it('reports stale, not unavailable, when the claim matched no rows', async () => {
    // A filtered UPDATE returning zero rows is not an error — somebody else got
    // there first. Retrying would be wrong, so it must not look like an outage.
    const { client } = makeSupabase({ work_orders: [{ data: [], error: null }] })
    await expect(acceptWorkOrder(client, WO, VENDOR, { scheduledAt: '2026-10-15T14:00:00.000Z', window: 'exact' }))
      .resolves.toEqual({ ok: false, reason: 'stale' })
  })

  it('accepts a date after needed_by, and tells the PM', async () => {
    const { client } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })

    // The vendor's honest date beats a refused form. Whether to wait or
    // re-route is the PM's call, so this succeeds AND notifies.
    const res = await acceptWorkOrder(client, WO, VENDOR, { scheduledAt: '2026-10-20T14:00:00.000Z', window: 'morning' })
    expect(res).toEqual({ ok: true, value: { afterNeededBy: true } })
    expect(createPmNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'amber', orgId: 'org_1' }),
    )
  })

  it('refuses a closed work order and an unassigned one without touching the db', async () => {
    const closed = makeSupabase({})
    await expect(acceptWorkOrder(closed.client, { ...WO, status: 'completed' }, VENDOR,
      { scheduledAt: '2026-10-15T00:00:00.000Z', window: 'exact' }))
      .resolves.toEqual({ ok: false, reason: 'already_closed' })
    expect(closed.calls).toEqual([])

    const orphan = makeSupabase({})
    await expect(acceptWorkOrder(orphan.client, { ...WO, vendor_id: null }, VENDOR,
      { scheduledAt: '2026-10-15T00:00:00.000Z', window: 'exact' }))
      .resolves.toEqual({ ok: false, reason: 'not_dispatched' })
    expect(orphan.calls).toEqual([])
  })

  it('attributes a technician by name in the audit row', async () => {
    const { client, calls } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
    await acceptWorkOrder(client, WO, TECH, { scheduledAt: '2026-10-15T00:00:00.000Z', window: 'exact' })

    const insert = calls.find((c) => c.table === 'work_order_updates' && c.method === 'insert')
    const row = insert?.args[0] as Record<string, unknown>
    expect(row.notes).toContain('Mike (technician)')
    // A technician holding a forwarded grant is still the vendor side.
    expect(row.updated_via_vendor_portal).toBe(true)
  })
})

describe('declineWorkOrder', () => {
  it('returns the work order to the unassigned queue', async () => {
    const { client, calls } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
    const res = await declineWorkOrder(client, WO, VENDOR, { reason: 'no_capacity', note: 'booked solid' })

    expect(res).toEqual({ ok: true, value: { vendorId: 'vend_1', stage: 'on_dispatch' } })

    const payload = updatePayload(calls)
    // 'pending' + a null vendor are what make it re-dispatchable at all:
    // dispatchWorkOrderToVendor advances status behind a forward-only
    // .in('status', ['pending','quote_requested']) filter.
    expect(payload).toMatchObject({
      status:                'pending',
      vendor_id:             null,
      vendor_progress:       'declined',
      vendor_decline_reason: 'no_capacity',
    })
    // A confirmed visit from a vendor who is off the job would still render on
    // the PM's calendar, which reads vendor_scheduled_at.
    expect(payload.vendor_scheduled_at).toBeNull()
    expect(payload.vendor_scheduled_window).toBeNull()
    // And the silence timer must stop nagging about a vendor who answered.
    expect(payload.vendor_dispatched_at).toBeNull()
  })

  it('distinguishes a cancellation after accepting from a refusal', async () => {
    const { client, calls } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
    const res = await declineWorkOrder(
      client, { ...WO, vendor_accepted_at: '2026-10-12T00:00:00Z' }, VENDOR,
      { reason: 'no_capacity', note: null },
    )

    expect(res).toEqual({ ok: true, value: { vendorId: 'vend_1', stage: 'after_accepting' } })
    expect(updatePayload(calls).vendor_progress).toBe('cancelled_by_vendor')
  })

  it('never claims a closed work order', async () => {
    const { client, calls } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
    await declineWorkOrder(client, WO, VENDOR, { reason: 'other', note: null })
    const not = calls.find((c) => c.table === 'work_orders' && c.method === 'not')
    expect(not?.args).toEqual(['status', 'in', '("completed","cancelled")'])
  })
})

describe('setVendorProgress', () => {
  it('maps the progress onto the lifecycle status', async () => {
    const { client, calls } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
    const accepted = { ...WO, vendor_accepted_at: '2026-10-12T00:00:00Z' }

    await expect(setVendorProgress(client, accepted, VENDOR, { progress: 'parts_ordered', note: null }))
      .resolves.toEqual({ ok: true, value: { status: 'in_progress' } })
    expect(updatePayload(calls)).toMatchObject({ status: 'in_progress', vendor_progress: 'parts_ordered' })
  })

  it('requires acceptance first', async () => {
    // Progress before acceptance would let a vendor skip the date entirely and
    // still look engaged, which is the silence the accept step exists to end.
    const { client, calls } = makeSupabase({})
    await expect(setVendorProgress(client, WO, VENDOR, { progress: 'tech_on_site', note: null }))
      .resolves.toEqual({ ok: false, reason: 'not_accepted' })
    expect(calls).toEqual([])
  })

  it('refuses to release the vendor through the progress path', async () => {
    // declineWorkOrder owns that: it also clears the appointment and fires the
    // re-dispatch. Routing a decline through here would set the status and
    // leave the work order assigned to a vendor who just quit.
    const { client, calls } = makeSupabase({})
    const accepted = { ...WO, vendor_accepted_at: '2026-10-12T00:00:00Z' }
    for (const progress of ['declined', 'cancelled_by_vendor'] as const) {
      await expect(setVendorProgress(client, accepted, VENDOR, { progress, note: null }))
        .resolves.toEqual({ ok: false, reason: 'not_accepted' })
    }
    expect(calls).toEqual([])
  })

  it('notifies the PM on both blocked states, and on neither other one', async () => {
    const accepted = { ...WO, vendor_accepted_at: '2026-10-12T00:00:00Z' }

    for (const progress of ['awaiting_access', 'hold_pm_approval'] as const) {
      vi.clearAllMocks()
      const { client } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
      await setVendorProgress(client, accepted, VENDOR, { progress, note: 'lockbox code is wrong' })
      expect(createPmNotification, progress).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ severity: 'red', href: '/maintenance/wo_1' }),
      )
    }

    for (const progress of ['on_the_way', 'tech_on_site', 'parts_ordered', 'repair_in_progress'] as const) {
      vi.clearAllMocks()
      const { client } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
      await setVendorProgress(client, accepted, VENDOR, { progress, note: null })
      expect(createPmNotification, progress).not.toHaveBeenCalled()
    }
  })

  it('dedupes a blocked alert per work order, kind and day', async () => {
    const { client } = makeSupabase({ work_orders: [{ data: [{ id: 'wo_1' }], error: null }] })
    const accepted = { ...WO, vendor_accepted_at: '2026-10-12T00:00:00Z' }
    await setVendorProgress(client, accepted, VENDOR, { progress: 'awaiting_access', note: null })

    const day = new Date().toISOString().slice(0, 10)
    expect(createPmNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dedupeKey: `work_order.vendor_blocked:wo_1:${day}` }),
    )
  })
})

describe('vendorDispatchFields', () => {
  it('starts the clock and clears the previous vendor entirely', () => {
    const fields = vendorDispatchFields('2026-10-11T12:00:00.000Z')
    expect(fields.vendor_dispatched_at).toBe('2026-10-11T12:00:00.000Z')

    // Every response field must clear. Leaving any one set shows the PM a
    // state belonging to a vendor who is no longer on the job.
    for (const key of [
      'vendor_progress', 'vendor_progress_at', 'vendor_progress_note',
      'vendor_accepted_at', 'vendor_declined_at', 'vendor_decline_reason',
      'vendor_scheduled_at', 'vendor_scheduled_window',
    ] as const) {
      expect(fields[key], key).toBeNull()
    }
  })
})
