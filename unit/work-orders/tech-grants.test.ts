import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import {
  mintTechnicianGrant,
  revokeTechnicianGrant,
  listTechnicianGrants,
  identifyTechnician,
  MAX_GRANTS_PER_WO,
  GRANT_FAILURES,
} from '@/lib/work-orders/tech-grants'
import { reportError } from '@/lib/observability/report-error'
import type { PortalWorkOrder, PortalPrincipal } from '@/lib/work-orders/portal-token'

type Resp = { data?: unknown; error?: unknown; count?: number | null }

function makeSupabase(byTable: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    const q = byTable[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'is', 'order', 'limit']) {
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
  wo_number: 'WO-1', title: 'Leak', category: 'plumbing', status: 'assigned',
  portal_enabled: true, completion_token_expires_at: null,
  needed_by_date: null, vendor_scheduled_at: null, vendor_scheduled_window: null,
  vendor_progress: null, vendor_accepted_at: null, nte_amount: null,
}

const VENDOR: PortalPrincipal = { kind: 'vendor', grantId: null, displayName: null }
const TECH: PortalPrincipal = { kind: 'technician', grantId: 'grant_9', displayName: 'Mike' }

beforeEach(() => vi.clearAllMocks())

describe('mintTechnicianGrant', () => {
  it('mints a link for the vendor', async () => {
    const { client } = makeSupabase({
      work_order_access_grants: [
        { count: 0, error: null },
        { data: { id: 'grant_1', token: 'tok_abc', expires_at: '2026-11-10T00:00:00Z' }, error: null },
      ],
    })

    const res = await mintTechnicianGrant(client, WO, VENDOR, 'Mike')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value).toEqual({ id: 'grant_1', token: 'tok_abc', expiresAt: '2026-11-10T00:00:00Z' })
  })

  it('refuses a technician, so forwarding cannot chain', async () => {
    // A technician minting further grants turns a bounded, revocable, per-job
    // credential into an unbounded chain the vendor cannot see, and the cap
    // below would then bound nothing.
    const { client, calls } = makeSupabase({})
    await expect(mintTechnicianGrant(client, WO, TECH, 'Dave'))
      .resolves.toEqual({ ok: false, reason: 'not_vendor' })
    expect(calls).toEqual([])
    expect(GRANT_FAILURES.not_vendor.status).toBe(403)
  })

  it('caps the grants per work order', async () => {
    const { client } = makeSupabase({
      work_order_access_grants: [{ count: MAX_GRANTS_PER_WO, error: null }],
    })
    await expect(mintTechnicianGrant(client, WO, VENDOR, null))
      .resolves.toEqual({ ok: false, reason: 'too_many' })
  })

  it('counts only live grants, scoped to this work order and org', async () => {
    const { client, calls } = makeSupabase({
      work_order_access_grants: [
        { count: 0, error: null },
        { data: { id: 'g', token: 't', expires_at: 'x' }, error: null },
      ],
    })
    await mintTechnicianGrant(client, WO, VENDOR, null)

    const eqs = calls.filter((c) => c.table === 'work_order_access_grants' && c.method === 'eq').map((c) => c.args)
    expect(eqs).toEqual(expect.arrayContaining([['work_order_id', 'wo_1'], ['org_id', 'org_1']]))
    // A revoked grant must not consume a slot forever.
    const nulls = calls.filter((c) => c.table === 'work_order_access_grants' && c.method === 'is').map((c) => c.args)
    expect(nulls).toEqual(expect.arrayContaining([['revoked_at', null]]))
  })

  it('caps the expiry at the parent work order link, never beyond it', async () => {
    // A technician token must never outlive the vendor's own access, or a
    // vendor whose link dies in two days could hand out thirty days of it.
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const { client, calls } = makeSupabase({
      work_order_access_grants: [
        { count: 0, error: null },
        { data: { id: 'g', token: 't', expires_at: soon }, error: null },
      ],
    })

    await mintTechnicianGrant(client, { ...WO, completion_token_expires_at: soon }, VENDOR, null)

    const insert = calls.find((c) => c.table === 'work_order_access_grants' && c.method === 'insert')
    const written = (insert?.args[0] as Record<string, unknown>).expires_at as string
    expect(new Date(written).getTime()).toBeLessThanOrEqual(new Date(soon).getTime())
  })

  it('reports unavailable rather than minting when the count read fails', async () => {
    // Failing OPEN here would let the cap be bypassed by an outage.
    const { client } = makeSupabase({
      work_order_access_grants: [{ count: null, error: { message: 'boom' } }],
    })
    await expect(mintTechnicianGrant(client, WO, VENDOR, null))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(reportError).toHaveBeenCalled()
  })
})

describe('revokeTechnicianGrant', () => {
  it('revokes one grant, scoped to the work order AND the org', async () => {
    const { client, calls } = makeSupabase({
      work_order_access_grants: [{ data: [{ id: 'grant_1' }], error: null }],
    })
    await expect(revokeTechnicianGrant(client, WO, VENDOR, 'grant_1'))
      .resolves.toEqual({ ok: true, value: { revoked: true } })

    // Both scopes, so a grant id belonging to another work order or org cannot
    // be revoked through this token.
    const eqs = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqs).toEqual(expect.arrayContaining([
      ['id', 'grant_1'], ['work_order_id', 'wo_1'], ['org_id', 'org_1'],
    ]))
  })

  it('refuses a technician', async () => {
    const { client, calls } = makeSupabase({})
    await expect(revokeTechnicianGrant(client, WO, TECH, 'grant_1'))
      .resolves.toEqual({ ok: false, reason: 'not_vendor' })
    expect(calls).toEqual([])
  })

  it('reports not_found on a second revoke rather than erroring', async () => {
    // `.is('revoked_at', null)` makes it idempotent: the caller's intent is
    // already satisfied, so this is not a failure to retry.
    const { client } = makeSupabase({ work_order_access_grants: [{ data: [], error: null }] })
    await expect(revokeTechnicianGrant(client, WO, VENDOR, 'grant_1'))
      .resolves.toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('listTechnicianGrants', () => {
  it('never returns a phone number', async () => {
    // The vendor knows his own people, and the number is not needed to render
    // the list, so it does not leave the database on this path.
    const { client, calls } = makeSupabase({
      work_order_access_grants: [{
        data: [{ id: 'g1', label: 'Mike', last_used_at: '2026-10-11T00:00:00Z', expires_at: 'x' }],
        error: null,
      }],
    })

    const grants = await listTechnicianGrants(client, WO)
    expect(grants).toEqual([
      { id: 'g1', label: 'Mike', lastUsedAt: '2026-10-11T00:00:00Z', expiresAt: 'x' },
    ])

    const select = calls.find((c) => c.table === 'work_order_access_grants' && c.method === 'select')
    expect(select?.args[0]).not.toContain('phone')
  })

  it('returns an empty list rather than throwing when the read fails', async () => {
    const { client } = makeSupabase({
      work_order_access_grants: [{ data: null, error: { message: 'boom' } }],
    })
    await expect(listTechnicianGrants(client, WO)).resolves.toEqual([])
  })
})

describe('identifyTechnician', () => {
  function fixture(grantResp: Resp, rosterResp: Resp = { data: { id: 'tech_1' }, error: null }) {
    return makeSupabase({
      vendor_technicians:       [rosterResp],
      work_order_access_grants: [grantResp],
    })
  }

  it('names the grant and creates the roster entry', async () => {
    const { client, calls } = fixture({ data: [{ id: 'g1', label: 'Mike' }], error: null })

    await expect(identifyTechnician(client, 'g1', 'org_1', 'vend_1', { name: 'Mike', phone: '(334) 555-1212' }))
      .resolves.toEqual({ ok: true, value: { label: 'Mike' } })

    const upsert = calls.find((c) => c.table === 'vendor_technicians' && c.method === 'upsert')
    const row = upsert?.args[0] as Record<string, unknown>
    // The phone IS the roster identity, so it is stored normalized or not at
    // all: a roster keyed on unnormalized text silently fragments into three
    // Mikes.
    expect(row.phone_e164).toBe('+13345551212')
    expect(upsert?.args[1]).toEqual({ onConflict: 'vendor_id,phone_e164' })
  })

  it('stores no number, and no conflict target, when none was given', async () => {
    const { client, calls } = fixture({ data: [{ id: 'g1', label: 'Mike' }], error: null })
    await identifyTechnician(client, 'g1', 'org_1', 'vend_1', { name: 'Mike', phone: null })

    const upsert = calls.find((c) => c.table === 'vendor_technicians' && c.method === 'upsert')
    expect((upsert?.args[0] as Record<string, unknown>).phone_e164).toBeNull()
    // The partial unique index only covers rows WITH a number, so naming it as
    // an arbiter with none would be wrong.
    expect(upsert?.args[1]).toBeUndefined()
  })

  it('drops an unusable number rather than storing it raw', async () => {
    const { client, calls } = fixture({ data: [{ id: 'g1', label: 'Mike' }], error: null })
    await identifyTechnician(client, 'g1', 'org_1', 'vend_1', { name: 'Mike', phone: 'call the office' })

    const upsert = calls.find((c) => c.table === 'vendor_technicians' && c.method === 'upsert')
    expect((upsert?.args[0] as Record<string, unknown>).phone_e164).toBeNull()
  })

  it('claims only an UNNAMED grant, so a shared link cannot be renamed', async () => {
    const { client, calls } = fixture({ data: [{ id: 'g1', label: 'Mike' }], error: null })
    await identifyTechnician(client, 'g1', 'org_1', 'vend_1', { name: 'Mike', phone: null })

    const nulls = calls
      .filter((c) => c.table === 'work_order_access_grants' && c.method === 'is')
      .map((c) => c.args)
    expect(nulls).toEqual(expect.arrayContaining([['label', null], ['revoked_at', null]]))
  })

  it('reports already_named when the grant was claimed first', async () => {
    const { client } = fixture({ data: [], error: null })
    await expect(identifyTechnician(client, 'g1', 'org_1', 'vend_1', { name: 'Dave', phone: null }))
      .resolves.toEqual({ ok: false, reason: 'already_named' })
  })

  it('still names the grant when the roster write fails', async () => {
    // The technician's access must not depend on a convenience for the
    // vendor's NEXT job. The degradation is a missing pick-list entry, not a
    // blocked job today.
    const { client, calls } = fixture(
      { data: [{ id: 'g1', label: 'Mike' }], error: null },
      { data: null, error: { message: 'boom' } },
    )

    await expect(identifyTechnician(client, 'g1', 'org_1', 'vend_1', { name: 'Mike', phone: null }))
      .resolves.toEqual({ ok: true, value: { label: 'Mike' } })

    expect(reportError).toHaveBeenCalledWith(
      { message: 'boom' },
      expect.objectContaining({ level: 'warning', orgId: 'org_1' }),
    )
    // And the failure must not have carried the number into the report.
    const reported = (reportError as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>
    expect(JSON.stringify(reported)).not.toMatch(/\+1|555/)

    const update = calls.find((c) => c.table === 'work_order_access_grants' && c.method === 'update')
    expect((update?.args[0] as Record<string, unknown>).technician_id).toBeNull()
  })

  it('rejects an empty name', async () => {
    const { client, calls } = makeSupabase({})
    await expect(identifyTechnician(client, 'g1', 'org_1', 'vend_1', { name: '   ', phone: null }))
      .resolves.toEqual({ ok: false, reason: 'not_found' })
    expect(calls).toEqual([])
  })
})

describe('GRANT_FAILURES', () => {
  it('carries no em dash in any message', () => {
    for (const [reason, failure] of Object.entries(GRANT_FAILURES)) {
      expect(failure.message, reason).not.toMatch(/—|&mdash;|&#8212;|&#x2014;/)
    }
  })
})
