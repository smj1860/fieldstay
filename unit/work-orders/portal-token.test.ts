import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { resolvePortalToken, PORTAL_FAILURES } from '@/lib/work-orders/portal-token'

type Resp = { data?: unknown; error?: unknown }

/**
 * One queue per table, consumed in call order, so a test can say "the vendor
 * token misses, the grant hits" without caring how the module sequences its
 * reads.
 */
function makeSupabase(byTable: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    const q = byTable[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ table, method: m, args }); return chain })
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    return chain
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, calls }
}

const WO_ROW = {
  id: 'wo_1', org_id: 'org_1', property_id: 'prop_1', vendor_id: 'vend_1',
  wo_number: 'WO-1042', title: 'Leak', category: 'plumbing', status: 'assigned',
  portal_enabled: true, completion_token_expires_at: null,
  needed_by_date: null, vendor_scheduled_at: null, vendor_scheduled_window: null,
  vendor_progress: null, vendor_accepted_at: null, nte_amount: null,
}

const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PAST   = new Date(Date.now() - 86_400_000).toISOString()

beforeEach(() => vi.clearAllMocks())

describe('resolvePortalToken: the vendor', () => {
  it('resolves the vendor token to a vendor principal', async () => {
    const { client } = makeSupabase({
      work_orders: [{ data: WO_ROW, error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })

    const res = await resolvePortalToken(client, 'tok', 'test')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.principal).toEqual({ kind: 'vendor', grantId: null, displayName: null })
    expect(res.workOrder.id).toBe('wo_1')
  })

  it('costs ONE query on the common path', async () => {
    // The grant lookup must only run when the vendor token misses, or every
    // dispatch-email click pays for a second read.
    const { client, calls } = makeSupabase({
      work_orders: [{ data: WO_ROW, error: null }],
      vendors:     [{ data: { org_id: 'org_1' }, error: null }],
    })
    await resolvePortalToken(client, 'tok', 'test')
    expect(calls.some((c) => c.table === 'work_order_access_grants')).toBe(false)
  })

  it('never reports a query failure as an invalid link', async () => {
    // Destructuring `data` alone collapses "errored" and "no such token" into
    // the same null: a contractor was told their link was invalid during a
    // database outage, nothing was logged, and the PM then tested the same
    // link successfully.
    const { client } = makeSupabase({ work_orders: [{ data: null, error: { message: 'boom' } }] })
    const res = await resolvePortalToken(client, 'tok', 'test')
    expect(res).toEqual({ ok: false, reason: 'unavailable' })
    expect(PORTAL_FAILURES.unavailable.status).toBe(503)
  })

  it('rejects a work order whose portal is off, and an expired token', async () => {
    const off = makeSupabase({ work_orders: [{ data: { ...WO_ROW, portal_enabled: false }, error: null }] })
    await expect(resolvePortalToken(off.client, 'tok', 'test'))
      .resolves.toEqual({ ok: false, reason: 'portal_disabled' })

    const expired = makeSupabase({
      work_orders: [{ data: { ...WO_ROW, completion_token_expires_at: PAST }, error: null }],
    })
    await expect(resolvePortalToken(expired.client, 'tok', 'test'))
      .resolves.toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a vendor from another org', async () => {
    const { client } = makeSupabase({
      work_orders: [{ data: WO_ROW, error: null }],
      vendors:     [{ data: { org_id: 'org_OTHER' }, error: null }],
    })
    await expect(resolvePortalToken(client, 'tok', 'test'))
      .resolves.toEqual({ ok: false, reason: 'vendor_mismatch' })
  })
})

describe('resolvePortalToken: a technician grant', () => {
  const GRANT = {
    id: 'grant_1', work_order_id: 'wo_1', org_id: 'org_1', vendor_id: 'vend_1',
    label: 'Mike', expires_at: FUTURE, revoked_at: null,
  }

  it('falls through to the grant and names the technician', async () => {
    const { client } = makeSupabase({
      work_orders:              [{ data: null, error: null }, { data: WO_ROW, error: null }],
      work_order_access_grants: [{ data: GRANT, error: null }],
      vendors:                  [{ data: { org_id: 'org_1' }, error: null }],
    })

    const res = await resolvePortalToken(client, 'tok', 'test')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.principal).toEqual({ kind: 'technician', grantId: 'grant_1', displayName: 'Mike' })
  })

  it('scopes the work-order read by the GRANT org, not the work order', async () => {
    // So a grant can only ever reach the work order in the org it was minted
    // for, even if the row were tampered with.
    const { client, calls } = makeSupabase({
      work_orders:              [{ data: null, error: null }, { data: WO_ROW, error: null }],
      work_order_access_grants: [{ data: GRANT, error: null }],
      vendors:                  [{ data: { org_id: 'org_1' }, error: null }],
    })
    await resolvePortalToken(client, 'tok', 'test')

    const woEqs = calls.filter((c) => c.table === 'work_orders' && c.method === 'eq').map((c) => c.args)
    expect(woEqs).toEqual(expect.arrayContaining([['id', 'wo_1'], ['org_id', 'org_1']]))
  })

  it('rejects a revoked grant before it reads the work order at all', async () => {
    const { client, calls } = makeSupabase({
      work_orders:              [{ data: null, error: null }],
      work_order_access_grants: [{ data: { ...GRANT, revoked_at: PAST }, error: null }],
    })
    await expect(resolvePortalToken(client, 'tok', 'test'))
      .resolves.toEqual({ ok: false, reason: 'revoked' })

    // Only the first (vendor-token) work_orders read happened; nothing about
    // the work order is revealed to a revoked link.
    expect(calls.filter((c) => c.table === 'work_orders' && c.method === 'select')).toHaveLength(1)
  })

  it('rejects an expired grant', async () => {
    const { client } = makeSupabase({
      work_orders:              [{ data: null, error: null }],
      work_order_access_grants: [{ data: { ...GRANT, expires_at: PAST }, error: null }],
    })
    await expect(resolvePortalToken(client, 'tok', 'test'))
      .resolves.toEqual({ ok: false, reason: 'expired' })
  })

  it('kills a grant once the work order moved to a different vendor', async () => {
    // A decline re-routes the work order. The previous technician's link must
    // stop working rather than let a stranger's crew into the property.
    const { client } = makeSupabase({
      work_orders:              [{ data: null, error: null }, { data: { ...WO_ROW, vendor_id: 'vend_OTHER' }, error: null }],
      work_order_access_grants: [{ data: GRANT, error: null }],
    })
    await expect(resolvePortalToken(client, 'tok', 'test'))
      .resolves.toEqual({ ok: false, reason: 'revoked' })
  })

  it('returns not_found for an unknown token', async () => {
    const { client } = makeSupabase({
      work_orders:              [{ data: null, error: null }],
      work_order_access_grants: [{ data: null, error: null }],
    })
    await expect(resolvePortalToken(client, 'tok', 'test'))
      .resolves.toEqual({ ok: false, reason: 'not_found' })
  })

  it('reports a grant-table failure as unavailable, not not_found', async () => {
    const { client } = makeSupabase({
      work_orders:              [{ data: null, error: null }],
      work_order_access_grants: [{ data: null, error: { message: 'boom' } }],
    })
    await expect(resolvePortalToken(client, 'tok', 'test'))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('PORTAL_FAILURES', () => {
  it('carries no em dash in any message', () => {
    for (const [reason, failure] of Object.entries(PORTAL_FAILURES)) {
      expect(failure.message, reason).not.toMatch(/—|&mdash;|&#8212;|&#x2014;/)
      expect(failure.message.length, reason).toBeGreaterThan(0)
    }
  })
})
