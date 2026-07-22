import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { getNotifications } from '@/lib/notifications'

type Resp = { data?: unknown; error?: unknown }

// `.from(table)` mock — records every chained call for assertions on filter
// args, and resolves to the queued response for that table. Mirrors the
// convention in unit/inngest/cron-vendor-compliance-grace-check.test.ts.
function makeSupabase(responses: Record<string, Resp>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(responses[table] ?? { data: null, error: null }).then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const EMPTY = {
  turnovers:                { data: [] },
  work_orders:               { data: [] },
  inventory_items:            { data: [] },
  vendor_compliance_status:   { data: [] },
  notifications:              { data: [] },
}

describe('getNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('returns an empty list when every source returns no rows', async () => {
    const supabase = makeSupabase(EMPTY)
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result).toEqual([])
  })

  it('maps a flagged turnover to a red alert and an unassigned turnover to an amber alert', async () => {
    const supabase = makeSupabase({
      ...EMPTY,
      turnovers: {
        data: [
          {
            id: 't1', checkout_datetime: '2026-07-22T16:00:00.000Z', status: 'flagged',
            properties: { name: 'Lake House' },
          },
          {
            id: 't2', checkout_datetime: '2026-07-23T16:00:00.000Z', status: 'pending_assignment',
            properties: [{ name: 'Cabin 2' }],
          },
        ],
      },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result).toEqual([
      expect.objectContaining({ id: 'turnover-t1', title: 'Flagged turnover', severity: 'red', href: '/turnovers/t1' }),
      expect.objectContaining({ id: 'turnover-t2', title: 'Unassigned turnover', severity: 'amber', href: '/turnovers/t2' }),
    ])
    expect(result[0]!.subtitle).toContain('Lake House')
    expect(result[1]!.subtitle).toContain('Cabin 2') // unwraps a nested-join array shape
  })

  it('maps an urgent work order to a red alert with the property name unwrapped', async () => {
    const supabase = makeSupabase({
      ...EMPTY,
      work_orders: {
        data: [{ id: 'wo1', title: 'Fix AC', properties: { name: 'Lake House' } }],
      },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result).toEqual([
      expect.objectContaining({
        id: 'wo-wo1', title: 'Urgent: Fix AC', subtitle: 'Lake House',
        href: '/maintenance/wo1', severity: 'red',
      }),
    ])
  })

  it('falls back to "Property" when the joined property is null', async () => {
    const supabase = makeSupabase({
      ...EMPTY,
      work_orders: { data: [{ id: 'wo1', title: 'Fix AC', properties: null }] },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result[0]!.subtitle).toBe('Property')
  })

  it('includes only inventory items that have been counted at least once and are below par', async () => {
    const supabase = makeSupabase({
      ...EMPTY,
      inventory_items: {
        data: [
          // Below par but never counted — must be excluded (no false "low stock" before a baseline count exists).
          { id: 'i1', name: 'Towels', current_quantity: 1, par_level: 10, first_count_recorded_at: null, properties: { name: 'Lake House' } },
          // Counted and below par — included.
          { id: 'i2', name: 'Soap', current_quantity: 2, par_level: 10, first_count_recorded_at: '2026-07-01T00:00:00Z', properties: { name: 'Lake House' } },
          // Counted but at/above par — excluded.
          { id: 'i3', name: 'Sheets', current_quantity: 10, par_level: 10, first_count_recorded_at: '2026-07-01T00:00:00Z', properties: { name: 'Lake House' } },
        ],
      },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(expect.objectContaining({
      id: 'inventory-i2', title: 'Low stock: Soap', severity: 'amber',
      href: '/inventory?filter=below_par',
    }))
    expect(result[0]!.subtitle).toBe('Lake House · 2/10')
  })

  it('caps below-par inventory alerts at 5 even when more items qualify', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `i${i}`, name: `Item ${i}`, current_quantity: 1, par_level: 10,
      first_count_recorded_at: '2026-07-01T00:00:00Z', properties: { name: 'Lake House' },
    }))
    const supabase = makeSupabase({ ...EMPTY, inventory_items: { data: items } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result).toHaveLength(5)
  })

  it('maps hard_blocked vendor compliance to a red alert and expiring/grace to amber', async () => {
    const supabase = makeSupabase({
      ...EMPTY,
      vendor_compliance_status: {
        data: [
          { vendor_id: 'v1', vendor_name: 'Acme Plumbing', compliance_status: 'hard_blocked' },
          { vendor_id: 'v2', vendor_name: 'Bob HVAC', compliance_status: 'expiring_soon' },
          { vendor_id: 'v3', vendor_name: 'Carol Electric', compliance_status: 'grace_period' },
        ],
      },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result).toEqual([
      expect.objectContaining({ id: 'vendor-v1', title: 'Acme Plumbing — compliance blocked', severity: 'red' }),
      expect.objectContaining({ id: 'vendor-v2', title: 'Bob HVAC — compliance expiring', severity: 'amber' }),
      expect.objectContaining({ id: 'vendor-v3', title: 'Carol Electric — compliance expiring', severity: 'amber' }),
    ])
  })

  it('maps persisted notifications with read state derived from read_at', async () => {
    const supabase = makeSupabase({
      ...EMPTY,
      notifications: {
        data: [
          { id: 'n1', title: 'WO completed', subtitle: null, href: '/wo/1', severity: 'green', read_at: null, created_at: '2026-07-22T10:00:00Z' },
          { id: 'n2', title: 'Turnover done', subtitle: 'Lake House', href: '/t/2', severity: 'blue', read_at: '2026-07-22T11:00:00Z', created_at: '2026-07-22T09:00:00Z' },
        ],
      },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result).toEqual([
      { id: 'n1', title: 'WO completed', subtitle: '', href: '/wo/1', severity: 'green', read: false },
      { id: 'n2', title: 'Turnover done', subtitle: 'Lake House', href: '/t/2', severity: 'blue', read: true },
    ])
  })

  it('orders live "currently true" alerts before the persisted event-log feed', async () => {
    const supabase = makeSupabase({
      ...EMPTY,
      work_orders: { data: [{ id: 'wo1', title: 'Fix AC', properties: { name: 'Lake House' } }] },
      notifications: {
        data: [{ id: 'n1', title: 'Past event', subtitle: null, href: '/x', severity: 'blue', read_at: null, created_at: '2026-07-22T09:00:00Z' }],
      },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result.map((r) => r.id)).toEqual(['wo-wo1', 'n1'])
  })

  it('treats a null data response (query error) the same as an empty result, not a crash', async () => {
    const supabase = makeSupabase({
      ...EMPTY,
      turnovers: { data: null, error: { message: 'boom' } },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const result = await getNotifications('org_1')

    expect(result).toEqual([])
  })

  it('scopes every query to the caller org id', async () => {
    const supabase = makeSupabase(EMPTY)
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    await getNotifications('org_42')

    const orgFilters = supabase.calls.filter((c) => c.method === 'eq' && c.args[0] === 'org_id')
    expect(orgFilters.length).toBeGreaterThanOrEqual(5) // one per table queried
    for (const call of orgFilters) {
      expect(call.args).toEqual(['org_id', 'org_42'])
    }
  })
})
