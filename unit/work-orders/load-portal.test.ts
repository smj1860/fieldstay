import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/work-orders/portal-token', () => ({ resolvePortalToken: vi.fn() }))
vi.mock('@/lib/work-orders/tech-grants', () => ({
  listTechnicianGrants: vi.fn(async () => []),
  touchGrant:           vi.fn(async () => undefined),
}))
vi.mock('@/lib/evidence/work-order-evidence', () => ({
  loadWorkOrderEvidence: vi.fn(async () => ({ before: [], after: [] })),
}))
vi.mock('@/lib/assets/manual-lookup', () => ({ getManualUrlForAsset: vi.fn(async () => null) }))
vi.mock('@/lib/supabase/unwrap', () => ({ unwrap: vi.fn((res: { data: unknown }) => res.data) }))

import { loadPortalPage } from '@/app/work-orders/[token]/load-portal'
import { createServiceClient } from '@/lib/supabase/server'
import { resolvePortalToken } from '@/lib/work-orders/portal-token'
import { listTechnicianGrants, touchGrant } from '@/lib/work-orders/tech-grants'
import { loadWorkOrderEvidence } from '@/lib/evidence/work-order-evidence'

const WO = {
  id: 'wo_1', org_id: 'org_1', property_id: 'prop_1', vendor_id: 'vend_1',
  wo_number: 'WO-1', title: 'Leak', category: 'plumbing', status: 'assigned',
  portal_enabled: true, completion_token_expires_at: null,
  needed_by_date: '2026-10-17', vendor_scheduled_at: null, vendor_scheduled_window: null,
  vendor_progress: null, vendor_accepted_at: null, nte_amount: 500,
}

const EXTRAS = {
  asset_id: null, description: 'Dripping', estimated_cost: 120, priority: 'high',
  properties: { name: 'Osprey Point', address: '1 Lake Rd', city: 'Dadeville', state: 'AL', zip: '36853' },
  vendors: { stripe_connect_token: 'ct_1', stripe_connect_charges_enabled: true },
}

function stubClient(extras: unknown = EXTRAS) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: extras, error: null }))
  const client = { from: vi.fn(() => chain) }
  ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(client)
  return client
}

function resolvesTo(value: unknown) {
  ;(resolvePortalToken as ReturnType<typeof vi.fn>).mockResolvedValue(value)
}

beforeEach(() => vi.clearAllMocks())

describe('loadPortalPage outcomes', () => {
  it('throws on a failed query rather than reporting a dead link', async () => {
    // The failure this surface keeps being bitten by: a contractor told their
    // link is invalid during a database outage, with nothing logged, while the
    // PM tests the same link successfully.
    stubClient()
    resolvesTo({ ok: false, reason: 'unavailable' })
    await expect(loadPortalPage('tok')).rejects.toThrow(/lookup failed/)
  })

  it('reports an expired link as expired, not as not_found', async () => {
    // So the portal keeps its "ask the property manager for a new one" screen
    // instead of a 404, which tells a contractor they are lost.
    stubClient()
    resolvesTo({ ok: false, reason: 'expired' })
    await expect(loadPortalPage('tok')).resolves.toEqual({ kind: 'expired' })
  })

  it('reports a REVOKED grant as expired too', async () => {
    // The holder cannot tell the difference and does not need to. Naming
    // revocation would tell whoever holds a leaked link that somebody noticed.
    stubClient()
    resolvesTo({ ok: false, reason: 'revoked' })
    await expect(loadPortalPage('tok')).resolves.toEqual({ kind: 'expired' })
  })

  it('reports every other refusal as not_found', async () => {
    stubClient()
    for (const reason of ['not_found', 'portal_disabled', 'vendor_mismatch'] as const) {
      resolvesTo({ ok: false, reason })
      await expect(loadPortalPage('tok'), reason).resolves.toEqual({ kind: 'not_found' })
    }
  })
})

describe('loadPortalPage: the vendor', () => {
  it('loads the work order and the vendor\'s technician grants', async () => {
    stubClient()
    resolvesTo({
      ok: true,
      principal: { kind: 'vendor', grantId: null, displayName: null },
      workOrder: WO,
    })
    ;(listTechnicianGrants as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'g1', label: 'Mike', lastUsedAt: null, expiresAt: 'x' },
    ])

    const load = await loadPortalPage('tok')
    expect(load.kind).toBe('ok')
    if (load.kind !== 'ok') return

    expect(load.data.workOrder).toMatchObject({
      id: 'wo_1', title: 'Leak', needed_by_date: '2026-10-17',
      description: 'Dripping', estimated_cost: 120, priority: 'high', nte_amount: 500,
    })
    expect(load.data.property?.name).toBe('Osprey Point')
    expect(load.data.vendorChargesEnabled).toBe(true)
    expect(load.data.technicianGrants).toHaveLength(1)
  })

  it('does not stamp a grant that does not exist', async () => {
    stubClient()
    resolvesTo({ ok: true, principal: { kind: 'vendor', grantId: null, displayName: null }, workOrder: WO })
    await loadPortalPage('tok')
    expect(touchGrant).not.toHaveBeenCalled()
  })
})

describe('loadPortalPage: a technician', () => {
  const TECH = { kind: 'technician', grantId: 'grant_1', displayName: 'Mike' }

  it('stamps the grant so the vendor can see it was opened', async () => {
    // work_orders.public_viewed_at was meant to answer this and nothing has
    // ever written it; last_used_at answers it per person.
    stubClient()
    resolvesTo({ ok: true, principal: TECH, workOrder: WO })
    await loadPortalPage('tok')
    expect(touchGrant).toHaveBeenCalledWith(expect.anything(), 'grant_1', 'org_1')
  })

  it('never loads the other people on the job', async () => {
    stubClient()
    resolvesTo({ ok: true, principal: TECH, workOrder: WO })

    const load = await loadPortalPage('tok')
    expect(load.kind).toBe('ok')
    if (load.kind !== 'ok') return

    expect(load.data.technicianGrants).toEqual([])
    expect(listTechnicianGrants).not.toHaveBeenCalled()
  })

  it('carries the self-entered name through, which is what gates the identify screen', async () => {
    stubClient()
    resolvesTo({ ok: true, principal: { ...TECH, displayName: null }, workOrder: WO })

    const load = await loadPortalPage('tok')
    if (load.kind !== 'ok') throw new Error('expected ok')
    // Null is what makes the technician page render IdentifyGate instead of the
    // job, so access details stay behind the name capture.
    expect(load.data.principal.displayName).toBeNull()
  })
})

describe('loadPortalPage: missing display extras', () => {
  it('is not_found when the second read returns nothing', async () => {
    stubClient(null)
    resolvesTo({ ok: true, principal: { kind: 'vendor', grantId: null, displayName: null }, workOrder: WO })
    await expect(loadPortalPage('tok')).resolves.toEqual({ kind: 'not_found' })
  })
})

describe('loadPortalPage: the property manager\'s before photos', () => {
  it('loads only the BEFORE side, scoped to the token\'s own work order, and maps it for the panel', async () => {
    stubClient()
    resolvesTo({ ok: true, principal: { kind: 'vendor', grantId: null }, workOrder: WO })
    ;(loadWorkOrderEvidence as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      before: [{ id: 'e1', url: 'https://signed/1', capturedAt: '2026-10-10T10:00:00Z', side: 'before', capturedByKind: 'pm', hashVerified: true }],
      after: [],
    })
    const out = await loadPortalPage('tok')
    expect(loadWorkOrderEvidence).toHaveBeenCalledWith(expect.anything(), { orgId: 'org_1', workOrderId: 'wo_1', sides: ['before'] })
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') expect(out.data.priorPhotos).toEqual([{ id: 'e1', url: 'https://signed/1', capturedAt: '2026-10-10T10:00:00Z' }])
  })
})

