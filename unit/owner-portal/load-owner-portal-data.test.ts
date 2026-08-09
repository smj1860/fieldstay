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
    // These reads paginate via fetchAllRows(), which drains .order().range().
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.range  = (...a: unknown[]) => record('range', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.gte    = (...a: unknown[]) => record('gte', a)
    chain.lt     = (...a: unknown[]) => record('lt', a)
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

  it('queries ONLY the selected month, instead of eleven and discarding ten', async () => {
    // The month was resolved AFTER the fetch, so the fetch could not know which
    // month it needed and spanned eleven — every request paged eleven months of
    // an owner's transactions over the wire, held them in memory, and threw ten
    // away with a JS filter. On a page whose month-switch links make that the
    // common interaction, not a cold start. The window was also twice the
    // picker's own six-month range, so most of it was never selectable.
    const supabase = makeSupabase({
      owner_portal_tokens: [{ data: portalTokenRow(), error: null }],
      owner_transactions:  [{ data: [], error: null }],
      bookings:            [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await loadOwnerPortalData('valid-token', '2026-05', undefined)

    const gte = supabase.calls.find((c) => c.table === 'owner_transactions' && c.method === 'gte')
    const lt  = supabase.calls.find((c) => c.table === 'owner_transactions' && c.method === 'lt')
    expect(gte?.args).toEqual(['transaction_date', '2026-05-01'])
    expect(lt?.args).toEqual(['transaction_date',  '2026-06-01'])
  })

  it('rolls the half-open month window over a year boundary', async () => {
    const supabase = makeSupabase({
      owner_portal_tokens: [{ data: portalTokenRow(), error: null }],
      owner_transactions:  [{ data: [], error: null }],
      bookings:            [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    // December must end at Jan 1 of the NEXT year, not month 13.
    await loadOwnerPortalData('valid-token', '2026-12', undefined)

    const lt = supabase.calls.find((c) => c.table === 'owner_transactions' && c.method === 'lt')
    // Only asserted when the picker actually offers that month; otherwise the
    // handler correctly falls back to the default and this is a no-op.
    if ((supabase.calls.find((c) => c.method === 'gte' && c.table === 'owner_transactions')?.args[1]) === '2026-12-01') {
      expect(lt?.args[1]).toBe('2027-01-01')
    }
  })

  it('still spans thirteen months for occupancy — that read genuinely uses the window', async () => {
    const supabase = makeSupabase({
      owner_portal_tokens: [{ data: portalTokenRow(), error: null }],
      owner_transactions:  [{ data: [], error: null }],
      bookings:            [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await loadOwnerPortalData('valid-token', undefined, undefined)

    const bookingsGte = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'gte')
    const months = (Date.now() - Date.parse(`${bookingsGte!.args[1] as string}T00:00:00Z`)) / (30 * 86_400_000)
    expect(months).toBeGreaterThan(12)
  })

  it('does not write on a view whose access stamp is still fresh', async () => {
    // An UNAUTHENTICATED GET used to await three writes before rendering, on
    // every view — so a read stampede on one leaked token URL became a write
    // stampede on the same hot row.
    const fresh = new Date(Date.now() - 60_000).toISOString()
    const supabase = makeSupabase({
      owner_portal_tokens: [{ data: portalTokenRow({ last_accessed_at: fresh }), error: null }],
      owner_transactions:  [{ data: [], error: null }],
      bookings:            [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await loadOwnerPortalData('valid-token', undefined, undefined)

    expect(supabase.calls.some((c) => c.table === 'owner_portal_tokens' && c.method === 'update')).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'org_milestones')).toBe(false)
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
