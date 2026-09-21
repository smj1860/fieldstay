import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Two devices, both offline at the same property, each independently
// noticing the same broken handrail: each mints its own crypto.randomUUID(),
// both requests reach this route with different ids, both pass validation,
// and both insert as two distinct, live work orders — mergeOfflineWorkOrders
// only dedupes by the client-minted id, and the upsert's ON CONFLICT (id)
// only protects against THIS device replaying THIS mutation. Neither layer
// has any concept of semantic duplication.
//
// This route now runs a soft duplicate check before inserting (never blocks
// the create — a false positive silently dropping a genuine second problem
// would be worse than the duplicate itself) and surfaces a
// `possibleDuplicateOf` hint in the response when an open work order on the
// same property has a title that reads as the same issue.
// ============================================================================

const auditMock = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireOrgRole: vi.fn(async () => ({
    supabase:   { from: fromMock },
    membership: { org_id: 'org_1' },
    user:       { id: 'user_1' },
  })),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: (...a: unknown[]) => auditMock(...a) }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/app/(dashboard)/maintenance/create-work-order-helpers', () => ({
  validateWorkOrderCreate: vi.fn(async () => ({ ok: true })),
  buildWorkOrderInsert: vi.fn((input: { title: string; property_id: string }, orgId: string) => ({
    usePortal: false,
    payload: { title: input.title, property_id: input.property_id, org_id: orgId, status: 'pending' },
  })),
  dispatchWorkOrderEvents: vi.fn(async () => {}),
}))

let duplicateCheckResult: { data: unknown; error: unknown } = { data: [], error: null }
let upsertResult:         { data: unknown; error: unknown } = { data: [{ id: 'new-wo' }], error: null }

// Table-keyed, call-order-based like record-consumption.test.ts's fake: the
// SAME table ('work_orders') is queried twice per request with different
// method chains (a select for the duplicate check, then an upsert for the
// actual insert), so the response depends on WHICH call this is, not just
// which table.
const fromMock = vi.fn((table: string) => {
  if (table !== 'work_orders') throw new Error(`unexpected table ${table}`)
  const chain: Record<string, unknown> = {}
  let resolved: { data: unknown; error: unknown } = duplicateCheckResult
  for (const m of ['select', 'eq', 'in', 'gte', 'order']) chain[m] = vi.fn(() => chain)
  chain.limit = vi.fn(() => chain)
  chain.upsert = vi.fn(() => { resolved = upsertResult; return chain })
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolved).then(resolve)
  return chain
})

import { POST } from '@/app/api/work-orders/route'

function req(body: unknown) {
  return new Request('https://app.fieldstay.app/api/work-orders', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

const VALID_BODY = { id: 'device-wo-1', title: 'Broken handrail on the deck', property_id: 'prop-1' }

beforeEach(() => {
  vi.clearAllMocks()
  duplicateCheckResult = { data: [], error: null }
  upsertResult         = { data: [{ id: 'new-wo' }], error: null }
})

describe('POST /api/work-orders — possible-duplicate detection', () => {
  it('creates the work order normally and carries no hint when nothing similar is open', async () => {
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.possibleDuplicateOf).toBeUndefined()
  })

  it('still creates the work order AND surfaces a hint when an open WO has a matching title', async () => {
    // Case/punctuation differences must still match — "Broken handrail on
    // the deck." vs "broken handrail on the deck" is the same issue typed
    // by two different crew members.
    duplicateCheckResult = {
      data: [{ id: 'existing-wo', title: 'Broken handrail on the deck.' }],
      error: null,
    }

    const res = await POST(req(VALID_BODY))

    expect(res.status).toBe(200)
    const body = await res.json()
    // The create is NOT blocked — a false positive dropping a genuine
    // second problem would be worse than a visible possible duplicate.
    expect(body.ok).toBe(true)
    expect(body.possibleDuplicateOf).toEqual({ id: 'existing-wo', title: 'Broken handrail on the deck.' })
  })

  it('does not flag an unrelated open work order on the same property', async () => {
    duplicateCheckResult = {
      data: [{ id: 'existing-wo', title: 'Pool pump making noise' }],
      error: null,
    }

    const res = await POST(req(VALID_BODY))

    const body = await res.json()
    expect(body.possibleDuplicateOf).toBeUndefined()
  })

  it('does not let a failed duplicate-check query block the create', async () => {
    duplicateCheckResult = { data: null, error: { message: 'boom' } }

    const res = await POST(req(VALID_BODY))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.possibleDuplicateOf).toBeUndefined()
  })
})
