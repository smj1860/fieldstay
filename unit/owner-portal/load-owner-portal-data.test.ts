import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { loadOwnerPortalData } from '@/app/owner/[token]/load-owner-portal-data'
import { createServiceClient } from '@/lib/supabase/server'

interface QueuedByTable {
  [table: string]: unknown[]
}

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table (single()/maybeSingle()/direct-await all resolve
// to it). `calls` records every filter method invocation for assertions
// about exactly what was queried — the tenant-isolation boundary this
// module exists to enforce lives entirely in those filter arguments.
function makeSupabase(queued: QueuedByTable) {
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
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.gte    = (...a: unknown[]) => record('gte', a)
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.upsert = (...a: unknown[]) => {
      record('upsert', a)
      return Promise.resolve({ error: null })
    }

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

const ORG_ID = 'org_1'

function portalTokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id:               'token_row_1',
    expires_at:       null,
    revoked_at:       null,
    last_accessed_at: null,
    is_multi:         false,
    property_ids:     null,
    property_owners: {
      id:                 'owner_1',
      org_id:             ORG_ID,
      name:               'Jane Owner',
      revenue_share_pct:  80,
      share_capital_plan: false,
      property_id:        'prop_1',
      properties: {
        id: 'prop_1', name: 'The Lakehouse', address: '1 Lake Dr', city: 'Austin', state: 'TX', zip: '78701',
      },
    },
    ...overrides,
  }
}

describe('loadOwnerPortalData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null for a token that does not exist', async () => {
    const supabase = makeSupabase({ owner_portal_tokens: [{ data: null, error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await loadOwnerPortalData('nonexistent-token', undefined, undefined)

    expect(result).toBeNull()
  })

  it('returns { status: "revoked" } without querying anything else', async () => {
    const supabase = makeSupabase({
      owner_portal_tokens: [{ data: portalTokenRow({ revoked_at: '2026-01-01T00:00:00Z' }), error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await loadOwnerPortalData('revoked-token', undefined, undefined)

    expect(result).toEqual({ status: 'revoked' })
    // Only the initial validation select — no last_accessed_at update, no
    // transaction/booking/capex queries for a token that's already dead.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('returns { status: "expired" } for a token past its expiry without querying anything else', async () => {
    const supabase = makeSupabase({
      owner_portal_tokens: [{ data: portalTokenRow({ expires_at: '2020-01-01T00:00:00Z' }), error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await loadOwnerPortalData('expired-token', undefined, undefined)

    expect(result).toEqual({ status: 'expired' })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('scopes single-property transactions to only that property', async () => {
    const supabase = makeSupabase({
      owner_portal_tokens: [{ data: portalTokenRow(), error: null }],
      owner_transactions: [{
        data: [
          { id: 't1', property_id: 'prop_1', transaction_type: 'revenue', category: 'booking_revenue', source: null, amount: 1000, description: null, transaction_date: new Date().toISOString().split('T')[0], notes: null },
        ],
        error: null,
      }],
      bookings: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await loadOwnerPortalData('valid-token', undefined, undefined)

    expect(result?.status).toBe('ok')
    if (result?.status !== 'ok') throw new Error('expected ok')
    expect(result.data.filteredTxns).toHaveLength(1)
    expect(result.data.capexPayload).toBeNull()

    const txnQuery = supabase.calls.find((c) => c.table === 'owner_transactions' && c.method === 'in')
    expect(txnQuery?.args[1]).toEqual(['prop_1'])
  })

  it('ignores a property query param outside the owner\'s scope and falls back to "all" (IDOR guard)', async () => {
    const supabase = makeSupabase({
      owner_portal_tokens: [{
        data: portalTokenRow({
          is_multi:     true,
          property_ids: ['prop_1', 'prop_2'],
        }),
        error: null,
      }],
      properties: [{
        data: [
          { id: 'prop_1', name: 'The Lakehouse', address: null, city: null, state: null, zip: null },
          { id: 'prop_2', name: 'The Cabin',     address: null, city: null, state: null, zip: null },
        ],
        error: null,
      }],
      owner_transactions: [{ data: [], error: null }],
      bookings: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    // 'prop_999' belongs to some other owner/org — not in this token's property_ids.
    const result = await loadOwnerPortalData('valid-token', undefined, 'prop_999')

    expect(result?.status).toBe('ok')
    if (result?.status !== 'ok') throw new Error('expected ok')
    expect(result.data.selectedProperty).toBe('all')

    const txnQuery = supabase.calls.find((c) => c.table === 'owner_transactions' && c.method === 'in')
    expect(txnQuery?.args[1]).toEqual(['prop_1', 'prop_2'])
    expect(txnQuery?.args[1]).not.toContain('prop_999')
  })

  it('strips capital-plan projection items for properties outside the owner\'s scope', async () => {
    const currentYear = new Date().getFullYear()

    const supabase = makeSupabase({
      owner_portal_tokens: [{
        data: portalTokenRow({
          property_owners: {
            ...portalTokenRow().property_owners,
            share_capital_plan: true,
          },
        }),
        error: null,
      }],
      owner_transactions: [{ data: [], error: null }],
      bookings: [{ data: [], error: null }],
      org_milestones: [{
        data: {
          value: {
            projections: {
              [currentYear]: {
                items: [
                  { property_id: 'prop_1', cost_low: 100, cost_high: 200 }, // in scope
                  { property_id: 'prop_9', cost_low: 500, cost_high: 900 }, // sibling property — NOT this owner's
                ],
                total_low:  600,
                total_high: 1100,
              },
            },
          },
        },
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await loadOwnerPortalData('valid-token', undefined, undefined)

    expect(result?.status).toBe('ok')
    if (result?.status !== 'ok') throw new Error('expected ok')

    const projection = result.data.capexPayload?.projections[currentYear]
    expect(projection?.items).toHaveLength(1)
    expect(projection?.items[0]?.property_id).toBe('prop_1')
    expect(projection?.items.some((i) => i.property_id === 'prop_9')).toBe(false)
    expect(projection?.total_low).toBe(100)
    expect(projection?.total_high).toBe(200)
  })
})
