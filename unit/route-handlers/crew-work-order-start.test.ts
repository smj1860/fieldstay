import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { POST } from '@/app/api/crew/work-orders/[id]/start/route'
import { createClient, createServiceClient } from '@/lib/supabase/server'
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

const WO_ID        = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const OTHER_ORG_WO = '2f1b8c44-1111-4222-8333-444455556666'

const CREW = { id: 'crew_1', org_id: 'org_1' }

function call(woId: string) {
  const req = new NextRequest(`http://localhost/api/crew/work-orders/${woId}/start`, { method: 'POST' })
  return POST(req, { params: Promise.resolve({ id: woId }) })
}

function signedInAs(crew: Resp['data']) {
  vi.mocked(createClient).mockResolvedValue(
    makeAuthClient('user_1', { data: crew, error: null }) as never,
  )
}

describe('POST /api/crew/work-orders/[id]/start', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no authenticated user, before touching the service client', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient(null, { data: null, error: null }) as never)

    const res = await call(WO_ID)

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 403 when the user has no active crew_members row', async () => {
    signedInAs(null)

    const res = await call(WO_ID)

    expect(res.status).toBe(403)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  // The IDOR guard is the org + assignment scoping on the lookup, not the id
  // in the URL. Asserted on the filters themselves: a route that returned 404
  // for the wrong reason would pass a status-only check.
  it('IDOR: 404 for another org\'s work order, and the lookup is scoped to org AND assignment', async () => {
    signedInAs(CREW)
    const service = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await call(OTHER_ORG_WO)

    expect(res.status).toBe(404)
    const eqs = service.calls.filter((c) => c.table === 'work_orders' && c.method === 'eq')
    expect(eqs.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
    expect(eqs.some((c) => c.args[0] === 'assigned_crew_member_id' && c.args[1] === 'crew_1')).toBe(true)
  })

  it('rejects a malformed id with 400, not the 503 the outbox would retry forever', async () => {
    signedInAs(CREW)
    const service = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await call('not-a-uuid')

    expect(res.status).toBe(400)
    expect(service.from).not.toHaveBeenCalled()
  })

  // A failed READ is 503 so lib/dexie/net.ts retries it. Answering 404 here
  // would dead-letter a queued start over a transient database blip.
  it('answers a failed read with 503 so the queued start retries', async () => {
    signedInAs(CREW)
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabase({ work_orders: [{ data: null, error: { message: 'timeout', code: '57014' } }] }) as never,
    )

    const res = await call(WO_ID)

    expect(res.status).toBe(503)
  })

  it('starts an assigned work order, writing in_progress and the history row', async () => {
    signedInAs(CREW)
    const service = makeSupabase({
      work_orders: [
        { data: { id: WO_ID, org_id: 'org_1', status: 'assigned' }, error: null },
        { data: { id: WO_ID }, error: null },
      ],
      work_order_updates: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await call(WO_ID)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ started: true })

    const update = service.calls.find((c) => c.table === 'work_orders' && c.method === 'update')
    expect((update?.args[0] as { status: string }).status).toBe('in_progress')

    // The compare-and-set that makes two concurrent starts safe: the UPDATE
    // only matches a row still in the status the read saw.
    const eqs = service.calls.filter((c) => c.table === 'work_orders' && c.method === 'eq')
    expect(eqs.some((c) => c.args[0] === 'status' && c.args[1] === 'assigned')).toBe(true)

    const history = service.calls.find((c) => c.table === 'work_order_updates' && c.method === 'insert')
    expect(history?.args[0]).toMatchObject({
      work_order_id: WO_ID,
      status_from:   'assigned',
      status_to:     'in_progress',
    })
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
  })

  it('starts a pending work order too', async () => {
    signedInAs(CREW)
    vi.mocked(createServiceClient).mockReturnValue(makeSupabase({
      work_orders: [
        { data: { id: WO_ID, org_id: 'org_1', status: 'pending' }, error: null },
        { data: { id: WO_ID }, error: null },
      ],
      work_order_updates: [{ data: null, error: null }],
    }) as never)

    const res = await call(WO_ID)

    expect(await res.json()).toEqual({ started: true })
  })

  // A replayed upload or a second tap must be a 200 no-op. Anything else
  // retries forever against a row that will never match again.
  it.each(['in_progress', 'completed'])(
    'is an idempotent 200 no-op when already %s, and writes nothing',
    async (status) => {
      signedInAs(CREW)
      const service = makeSupabase({
        work_orders: [{ data: { id: WO_ID, org_id: 'org_1', status }, error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(service as never)

      const res = await call(WO_ID)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ alreadyStarted: true })
      expect(service.calls.some((c) => c.method === 'update')).toBe(false)
      expect(service.calls.some((c) => c.table === 'work_order_updates')).toBe(false)
      expect(logAuditEvent).not.toHaveBeenCalled()
    },
  )

  // Nothing removes a cancelled WO from the device, so a crew member can be
  // looking at one. 409 because 4xx is terminal in lib/dexie/net.ts: this
  // refusal is permanent and must not retry.
  it('refuses a cancelled work order with a terminal 409 and changes nothing', async () => {
    signedInAs(CREW)
    const service = makeSupabase({
      work_orders: [{ data: { id: WO_ID, org_id: 'org_1', status: 'cancelled' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await call(WO_ID)

    expect(res.status).toBe(409)
    expect(service.calls.some((c) => c.method === 'update')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  // Losing the compare-and-set means another request already started it and
  // already wrote the history row.
  it('writes no second history row when it loses the race', async () => {
    signedInAs(CREW)
    const service = makeSupabase({
      work_orders: [
        { data: { id: WO_ID, org_id: 'org_1', status: 'assigned' }, error: null },
        { data: null, error: null },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await call(WO_ID)

    expect(await res.json()).toEqual({ alreadyStarted: true })
    expect(service.calls.some((c) => c.table === 'work_order_updates')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  // The status is already committed when the history insert runs. Failing the
  // whole request would make the crew member's queued start retry against a
  // row that no longer matches, which is a worse outcome than a missing line.
  it('still succeeds when the history row fails to insert', async () => {
    signedInAs(CREW)
    vi.mocked(createServiceClient).mockReturnValue(makeSupabase({
      work_orders: [
        { data: { id: WO_ID, org_id: 'org_1', status: 'assigned' }, error: null },
        { data: { id: WO_ID }, error: null },
      ],
      work_order_updates: [{ data: null, error: { message: 'nope', code: '23503' } }],
    }) as never)

    const res = await call(WO_ID)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ started: true })
  })
})
