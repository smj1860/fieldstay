import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { POST } from '@/app/api/crew/work-orders/[id]/complete/route'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { makeSupabase, makeAuthClient, WO_ID, OTHER_ORG_WO, OTHER_CREW_WO } from './crew-work-order-harness'

function postRequest(body: unknown = {}) {
  return new NextRequest('http://localhost/api/crew/work-orders/wo_1/complete', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

function call(woId: string, body: unknown = {}) {
  return POST(postRequest(body), { params: Promise.resolve({ id: woId }) })
}

describe('POST /api/crew/work-orders/[id]/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when there is no authenticated user', async () => {
    const authClient = makeAuthClient(null, { data: null, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)

    const res = await call(WO_ID)

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 403 when the authenticated user has no active crew_members row', async () => {
    const authClient = makeAuthClient('user_1', { data: null, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)

    const res = await call(WO_ID)

    expect(res.status).toBe(403)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('IDOR: returns 404 when the work order belongs to a different org than the crew member, even with a valid session', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call(OTHER_ORG_WO)

    expect(res.status).toBe(404)
    expect(inngest.send).not.toHaveBeenCalled()
    // The WO lookup is scoped both to the crew member's own org AND to this
    // crew member's own assignment — not just the id in the URL.
    const lookupCalls = serviceClient.calls.filter((c) => c.table === 'work_orders' && c.method === 'eq')
    expect(lookupCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
    expect(lookupCalls.some((c) => c.args[0] === 'assigned_crew_member_id' && c.args[1] === 'crew_1')).toBe(true)
  })

  it('IDOR: returns 404 when the work order belongs to the crew member\'s own org but is assigned to a different crew member', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    // The service-client query itself filters assigned_crew_member_id=crew_1,
    // so a WO assigned to someone else returns no row.
    const serviceClient = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call(OTHER_CREW_WO)

    expect(res.status).toBe(404)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  // work_orders.id is a uuid column. This route answers a failed READ with 503
  // on purpose, so a transient DB error retries rather than dead-lettering the
  // crew member's queued completion — but a malformed id is NOT transient, so
  // without a boundary check it 503-loops forever: the outbox never drains and
  // none of it is visible to the dead-letter banner.
  it('rejects a malformed work order id with 400 rather than a 503 the outbox retries forever', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call('not-a-uuid')

    expect(res.status).toBe(400)
    expect(serviceClient.from).not.toHaveBeenCalled()
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('rejects oversized completion notes without touching the work order', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call(WO_ID, { notes: 'x'.repeat(2001) })

    expect(res.status).toBe(400)
    expect(serviceClient.from).not.toHaveBeenCalled()
  })

  it('returns alreadyCompleted when the work order is already completed', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [{ data: { id: WO_ID, org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'completed' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call(WO_ID)
    const json = await res.json()

    expect(json).toEqual({ alreadyCompleted: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  // Neither half of this guarded. The check above only catches `completed`,
  // and the claim UPDATE's `.neq('status', 'completed')` MATCHES a cancelled
  // row — so completing a cancelled work order flipped it to `completed` and
  // ran the whole side-effect chain, including the owner_transactions
  // maintenance expense, for work that was called off.
  //
  // 409, not 404 or 500: lib/dexie/net.ts treats 4xx as terminal, and this
  // refusal is permanent, so the queued mutation must stop rather than retry
  // forever. Same answer the turnover complete route already gave.
  it('refuses a cancelled work order with 409 and writes nothing', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [{ data: { id: WO_ID, org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'cancelled' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res  = await call(WO_ID)
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/was cancelled/i)
    expect(serviceClient.calls.some((c) => c.method === 'update')).toBe(false)
    expect(inngest.send).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  // The read produces the message; the WHERE clause is what makes it
  // race-safe against a cancellation landing between the two.
  it('excludes cancelled in the claim UPDATE itself, not only in the earlier read', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [
        { data: { id: WO_ID, org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'in_progress' }, error: null },
        { data: null, error: null },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    await call(WO_ID)

    const neqs = serviceClient.calls.filter((c) => c.method === 'neq').map((c) => c.args)
    expect(neqs).toContainEqual(['status', 'completed'])
    expect(neqs).toContainEqual(['status', 'cancelled'])
  })

  it('returns alreadyCompleted without re-firing the event when a concurrent request already won the completion claim', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [
        { data: { id: WO_ID, org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'in_progress' }, error: null },
        { data: null, error: null }, // claim update — lost the race
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call(WO_ID)
    const json = await res.json()

    expect(json).toEqual({ alreadyCompleted: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('returns 500 on a DB error during the completion claim', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [
        { data: { id: WO_ID, org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'in_progress' }, error: null },
        { data: null, error: { message: 'db down' } },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call(WO_ID)

    expect(res.status).toBe(500)
  })

  it('completes a work order assigned to this crew member, notifies the PM via Inngest, and logs an audit event', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [
        { data: { id: WO_ID, wo_number: 'WO-1', title: 'Fix sink', property_id: 'prop_1', org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'in_progress' }, error: null },
        { data: { id: WO_ID }, error: null },
      ],
      work_order_updates: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call(WO_ID, { notes: 'Replaced the trap' })
    const json = await res.json()

    expect(json).toEqual({ completed: true })
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
      name: 'work-order/crew.completed',
      data: expect.objectContaining({
        workOrderId:  WO_ID,
        orgId:        'org_1',
        crewMemberId: 'crew_1',
        notes:        'Replaced the trap',
      }),
    }))
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org_1', actorId: 'user_1', action: 'work_order.updated', targetId: WO_ID,
    }))
  })
})
