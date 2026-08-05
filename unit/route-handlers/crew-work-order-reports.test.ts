import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  // The PM notification is a service-role insert: `notifications` has no
  // INSERT policy for org members, and crew authenticate with the
  // RLS-enforced client.
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { POST } from '@/app/api/crew/work-order-reports/route'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { logAuditEvent } from '@/lib/audit'

const CREW_ID = 'crew_1'
const ORG_ID  = 'org_1'
const USER_ID = 'user_1'
const PROP_ID = 'property_1'

type QueuedByTable = Record<string, Array<{ data?: unknown; error?: unknown }>>

function makeSupabase(user: { id: string } | null, queued: QueuedByTable = {}) {
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
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.not    = (...a: unknown[]) => record('not', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    // requireCrewMember() and the crew route reads use maybeSingle().
    chain.maybeSingle = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return {
    auth: { getUser: vi.fn(async () => ({ data: { user } })) },
    from,
    calls,
  }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/crew/work-order-reports', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

const baseBody = {
  report_id:   'report_1',
  property_id: PROP_ID,
  title:       'Leaking faucet',
}

describe('POST /api/crew/work-order-reports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createServiceClient).mockReturnValue(makeSupabase({ id: USER_ID }) as never)
  })

  it('rejects a missing report_id before touching auth', async () => {
    const res = await POST(postRequest({ property_id: PROP_ID, title: 'x' }))
    expect(res.status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects a missing property_id before touching auth', async () => {
    const res = await POST(postRequest({ report_id: 'r1', title: 'x' }))
    expect(res.status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects a missing/blank title before touching auth', async () => {
    const res = await POST(postRequest({ report_id: 'r1', property_id: PROP_ID, title: '   ' }))
    expect(res.status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated caller', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabase(null) as never)

    const res = await POST(postRequest(baseBody))

    expect(res.status).toBe(401)
  })

  it('rejects a session user with no matching active crew_members row', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({ id: USER_ID }, { crew_members: [{ data: null, error: null }] }) as never,
    )

    const res = await POST(postRequest(baseBody))

    expect(res.status).toBe(403)
  })

  it('rejects a property_id that does not belong to the crew member\'s org (IDOR)', async () => {
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members: [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:   [{ data: null, error: null }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest({ ...baseBody, property_id: 'other_org_property' }))

    expect(res.status).toBe(404)
    const eqCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(supabase.calls.some((c) => c.table === 'work_orders')).toBe(false)
  })

  it('rejects an asset_id that does not belong to the reported property/org (IDOR)', async () => {
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members:    [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:      [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        property_assets: [{ data: null, error: null }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest({ ...baseBody, asset_id: 'other_property_asset' }))

    expect(res.status).toBe(404)
    const eqCalls = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(eqCalls.some((c) => c.args[0] === 'property_id' && c.args[1] === PROP_ID)).toBe(true)
    expect(supabase.calls.some((c) => c.table === 'work_orders')).toBe(false)
  })

  it('creates a crew_flag work order with a derived category/priority on the happy path (no asset)', async () => {
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members: [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:   [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        work_orders:  [{ data: { id: 'wo_1' }, error: null }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest(baseBody))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })

    const insertCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(insertCall!.args[0]).toEqual({
      org_id:                     ORG_ID,
      property_id:                PROP_ID,
      asset_id:                   null,
      title:                      'Leaking faucet',
      category:                   'general',
      priority:                   'medium',
      status:                     'pending',
      source:                     'crew_flag',
      reported_by_crew_member_id: CREW_ID,
      client_report_id:           'report_1',
    })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      ORG_ID,
        actorId:    USER_ID,
        action:     'work_order.created',
        targetType: 'work_order',
      }),
    )
  })

  it('derives category from the selected asset type and marks urgent priority for an emergency report', async () => {
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members:    [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:      [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        property_assets: [{ data: { id: 'asset_1', asset_type: 'hvac' }, error: null }],
        work_orders:     [{ data: { id: 'wo_1' }, error: null }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest({ ...baseBody, asset_id: 'asset_1', is_emergency: true }))

    expect(res.status).toBe(200)
    const insertCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(insertCall!.args[0]).toEqual(
      expect.objectContaining({ asset_id: 'asset_1', category: 'hvac', priority: 'urgent' }),
    )
  })

  it('treats a unique_violation on client_report_id as an already-applied duplicate, not an error', async () => {
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members: [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:   [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        work_orders:  [{ data: null, error: { code: '23505' } }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest(baseBody))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true, duplicate: true })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  // This route is the ONE crew work-order path, and it used to do a bare
  // insert and stop. With no event of any kind, a crew flag reached the PM
  // only via the 6pm daily wrap-up digest's `vendor_id IS NULL` sweep — up to
  // a day late, and the same delay for a burst pipe as for a loose cabinet.
  it('notifies the PM immediately, linked to the new work order', async () => {
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members: [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:   [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        work_orders:  [{ data: { id: 'wo_1' }, error: null }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest(baseBody))

    expect(res.status).toBe(200)
    expect(createPmNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId:     ORG_ID,
        type:      'work_order_created',
        href:      '/maintenance/wo_1',
        subtitle:  'Leaking faucet',
        severity:  'amber',
        dedupeKey: 'crew-flag-report_1',
      }),
    )
  })

  it('raises the severity and the title for an emergency flag', async () => {
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members: [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:   [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        work_orders:  [{ data: { id: 'wo_1' }, error: null }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    await POST(postRequest({ ...baseBody, is_emergency: true }))

    const arg = vi.mocked(createPmNotification).mock.calls[0]![1]
    expect(arg.severity).toBe('red')
    expect(arg.title).toContain('Urgent')
    expect(arg.title).toContain('Lakeview Cabin')
  })

  it('still notifies on an outbox retry, and dedupes on the report id', async () => {
    // The retry exists because the first response was lost — and the
    // notification may have been what was lost with it. The work order id is
    // NOT stable here (the insert returns nothing), so the dedupe key is keyed
    // on the client report id, which the retry reproduces exactly.
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members: [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:   [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        work_orders:  [{ data: null, error: { code: '23505' } }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)
    // The service client recovers the id the first attempt created.
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabase({ id: USER_ID }, { work_orders: [{ data: { id: 'wo_1' }, error: null }] }) as never,
    )

    const res = await POST(postRequest(baseBody))

    await expect(res.json()).resolves.toEqual({ success: true, duplicate: true })
    expect(createPmNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ href: '/maintenance/wo_1', dedupeKey: 'crew-flag-report_1' }),
    )
  })

  it('does not fail the crew report when the notification throws', async () => {
    // The work order is already committed. A failed notification must never
    // ask a crew member to re-report.
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members: [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:   [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        work_orders:  [{ data: { id: 'wo_1' }, error: null }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)
    vi.mocked(createPmNotification).mockRejectedValueOnce(new Error('notifications down'))

    const res = await POST(postRequest(baseBody))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })
    expect(logAuditEvent).toHaveBeenCalled()
  })

  it('returns 500 on a non-duplicate insert error', async () => {
    const supabase = makeSupabase(
      { id: USER_ID },
      {
        crew_members: [{ data: { id: CREW_ID, org_id: ORG_ID }, error: null }],
        properties:   [{ data: { id: PROP_ID, org_id: ORG_ID, name: 'Lakeview Cabin' }, error: null }],
        work_orders:  [{ data: null, error: { code: '500', message: 'db down' } }],
      },
    )
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await POST(postRequest(baseBody))

    expect(res.status).toBe(500)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
