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

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

function makeAuthClient(userId: string | null, crewResult: Resp) {
  const getUser = vi.fn(async () => ({ data: { user: userId ? { id: userId } : null } }))
  const { from } = makeSupabase({ crew_members: [crewResult] })
  return { auth: { getUser }, from }
}

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

    const res = await call('wo_1')

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 403 when the authenticated user has no active crew_members row', async () => {
    const authClient = makeAuthClient('user_1', { data: null, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)

    const res = await call('wo_1')

    expect(res.status).toBe(403)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('IDOR: returns 404 when the work order belongs to a different org than the crew member, even with a valid session', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call('other-orgs-wo')

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

    const res = await call('wo_assigned_to_someone_else')

    expect(res.status).toBe(404)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('returns alreadyCompleted when the work order is already completed', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [{ data: { id: 'wo_1', org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'completed' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call('wo_1')
    const json = await res.json()

    expect(json).toEqual({ alreadyCompleted: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('returns alreadyCompleted without re-firing the event when a concurrent request already won the completion claim', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [
        { data: { id: 'wo_1', org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'in_progress' }, error: null },
        { data: null, error: null }, // claim update — lost the race
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call('wo_1')
    const json = await res.json()

    expect(json).toEqual({ alreadyCompleted: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('returns 500 on a DB error during the completion claim', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [
        { data: { id: 'wo_1', org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'in_progress' }, error: null },
        { data: null, error: { message: 'db down' } },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call('wo_1')

    expect(res.status).toBe(500)
  })

  it('completes a work order assigned to this crew member, notifies the PM via Inngest, and logs an audit event', async () => {
    const authClient = makeAuthClient('user_1', { data: { id: 'crew_1', org_id: 'org_1' }, error: null })
    vi.mocked(createClient).mockResolvedValue(authClient as never)
    const serviceClient = makeSupabase({
      work_orders: [
        { data: { id: 'wo_1', wo_number: 'WO-1', title: 'Fix sink', property_id: 'prop_1', org_id: 'org_1', assigned_crew_member_id: 'crew_1', status: 'in_progress' }, error: null },
        { data: { id: 'wo_1' }, error: null },
      ],
      work_order_updates: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(serviceClient as never)

    const res = await call('wo_1', { notes: 'Replaced the trap' })
    const json = await res.json()

    expect(json).toEqual({ completed: true })
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
      name: 'work-order/crew.completed',
      data: expect.objectContaining({
        workOrderId:  'wo_1',
        orgId:        'org_1',
        crewMemberId: 'crew_1',
        notes:        'Replaced the trap',
      }),
    }))
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org_1', actorId: 'user_1', action: 'work_order.updated', targetId: 'wo_1',
    }))
  })
})
