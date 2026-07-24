import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import {
  getPlanStatus,
  getRecentTurnovers,
  getIntegrationStatus,
  getRecentPurchaseOrders,
  callAccountTool,
  ACCOUNT_TOOLS,
} from '@/lib/support/account-tools'

type Resp = { data?: unknown; error?: unknown; count?: number | null }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

const ORG_ID = 'org_1'

describe('getPlanStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns plan/billing info scoped to the given org', async () => {
    const supabase = makeSupabase({
      organizations:       [{ data: { plan: 'growth', plan_status: 'active', created_at: '2025-01-01T00:00:00Z' }, error: null }],
      properties:           [{ data: null, count: 7, error: null }],
      guidebook_sponsors:   [{ data: null, count: 2, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getPlanStatus(ORG_ID)

    expect(result).toEqual({
      plan: 'growth', planStatus: 'active', accountCreated: '2025-01-01T00:00:00Z',
      activePropertyCount: 7, activeSponsorCount: 2,
    })
    expect(supabase.calls.some((c) => c.table === 'organizations' && c.method === 'eq' && c.args[0] === 'id' && c.args[1] === ORG_ID)).toBe(true)
    expect(supabase.calls.some((c) => c.table === 'properties' && c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(supabase.calls.some((c) => c.table === 'guidebook_sponsors' && c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
  })

  it('returns an error when the organization is not found', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getPlanStatus(ORG_ID)

    expect(result).toEqual({ error: 'Could not find account information.' })
  })

  it('defaults counts to 0 when the count comes back null', async () => {
    const supabase = makeSupabase({
      organizations:     [{ data: { plan: 'starter', plan_status: 'trialing', created_at: '2026-01-01T00:00:00Z' }, error: null }],
      properties:         [{ data: null, count: null, error: null }],
      guidebook_sponsors: [{ data: null, count: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getPlanStatus(ORG_ID)

    expect(result).toMatchObject({ activePropertyCount: 0, activeSponsorCount: 0 })
  })
})

describe('getRecentTurnovers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps turnover rows, unwrapping a nested-join array of one property', async () => {
    const supabase = makeSupabase({
      turnovers: [{
        data: [{
          id: 't1', status: 'assigned', checkin_datetime: '2026-07-25T16:00:00Z',
          checkout_datetime: '2026-07-22T10:00:00Z', is_same_day_turnover: false,
          properties: [{ name: 'Lakeside Lodge' }],
        }],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getRecentTurnovers(ORG_ID)

    expect(result).toEqual({
      count: 1,
      turnovers: [{
        property: 'Lakeside Lodge', status: 'assigned',
        checkout: '2026-07-22T10:00:00Z', checkin: '2026-07-25T16:00:00Z', sameDayFlip: false,
      }],
    })
  })

  it('unwraps a nested join returned as a single object rather than an array', async () => {
    const supabase = makeSupabase({
      turnovers: [{
        data: [{
          id: 't2', status: 'completed', checkin_datetime: null, checkout_datetime: '2026-07-20T10:00:00Z',
          is_same_day_turnover: true, properties: { name: 'Mountain Cabin' },
        }],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getRecentTurnovers(ORG_ID)

    if ('error' in result) throw new Error('expected a turnovers result')
    expect(result.turnovers[0]?.property).toBe('Mountain Cabin')
  })

  it('scopes to the given org and returns an error message on a query error', async () => {
    const supabase = makeSupabase({
      turnovers: [{ data: null, error: { message: 'db down' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getRecentTurnovers(ORG_ID)

    expect(result).toEqual({ error: 'Could not fetch turnovers.' })
    expect(supabase.calls.some((c) => c.table === 'turnovers' && c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
  })

  it('returns a zero count with an empty list when there are no matching turnovers', async () => {
    const supabase = makeSupabase({ turnovers: [{ data: [], error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getRecentTurnovers(ORG_ID)

    expect(result).toEqual({ count: 0, turnovers: [] })
  })
})

describe('getIntegrationStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps integration connections, falling back to provider_id when the join is missing', async () => {
    const supabase = makeSupabase({
      integration_connections: [{
        data: [
          { provider_id: 'hospitable', status: 'active', last_used_at: '2026-07-20T00:00:00Z', connected_at: '2026-01-01T00:00:00Z', integration_providers: { display_name: 'Hospitable' } },
          { provider_id: 'ownerrez', status: 'error', last_used_at: null, connected_at: '2026-02-01T00:00:00Z', integration_providers: null },
        ],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getIntegrationStatus(ORG_ID)

    expect(result).toEqual({
      connections: [
        { provider: 'Hospitable', status: 'active', lastUsedAt: '2026-07-20T00:00:00Z', connectedAt: '2026-01-01T00:00:00Z' },
        { provider: 'ownerrez', status: 'error', lastUsedAt: null, connectedAt: '2026-02-01T00:00:00Z' },
      ],
    })
  })

  it('returns an error message on a query error', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: null, error: { message: 'boom' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getIntegrationStatus(ORG_ID)

    expect(result).toEqual({ error: 'Could not fetch integration status.' })
  })
})

describe('getRecentPurchaseOrders', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps purchase order rows scoped to the given org', async () => {
    const supabase = makeSupabase({
      purchase_orders: [{
        data: [{
          id: 'po1', created_at: '2026-07-21T00:00:00Z', order_email_sent: true, is_same_day_flip: false,
          properties: [{ name: 'Lakeside Lodge' }],
        }],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getRecentPurchaseOrders(ORG_ID)

    expect(result).toEqual({
      count: 1,
      orders: [{ property: 'Lakeside Lodge', createdAt: '2026-07-21T00:00:00Z', emailSent: true, sameDayFlip: false }],
    })
    expect(supabase.calls.some((c) => c.table === 'purchase_orders' && c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
  })

  it('returns an error message on a query error', async () => {
    const supabase = makeSupabase({
      purchase_orders: [{ data: null, error: { message: 'boom' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getRecentPurchaseOrders(ORG_ID)

    expect(result).toEqual({ error: 'Could not fetch purchase orders.' })
  })
})

describe('ACCOUNT_TOOLS', () => {
  it('takes no model-supplied input parameters on any tool — orgId is always injected server-side', () => {
    for (const tool of ACCOUNT_TOOLS) {
      expect(tool.input_schema.properties).toEqual({})
    }
  })

  it('declares exactly the four tools callAccountTool knows how to dispatch', () => {
    const names = ACCOUNT_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([
      'get_integration_status', 'get_plan_status', 'get_recent_purchase_orders', 'get_recent_turnovers',
    ])
  })
})

describe('callAccountTool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dispatches get_plan_status to getPlanStatus scoped to orgId', async () => {
    const supabase = makeSupabase({
      organizations:      [{ data: { plan: 'pro', plan_status: 'active', created_at: '2026-01-01' }, error: null }],
      properties:         [{ data: null, count: 3, error: null }],
      guidebook_sponsors: [{ data: null, count: 1, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_plan_status', ORG_ID)

    expect(result).toMatchObject({ plan: 'pro' })
  })

  it('dispatches get_recent_turnovers', async () => {
    const supabase = makeSupabase({ turnovers: [{ data: [], error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_recent_turnovers', ORG_ID)

    expect(result).toEqual({ count: 0, turnovers: [] })
  })

  it('dispatches get_integration_status', async () => {
    const supabase = makeSupabase({ integration_connections: [{ data: [], error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_integration_status', ORG_ID)

    expect(result).toEqual({ connections: [] })
  })

  it('dispatches get_recent_purchase_orders', async () => {
    const supabase = makeSupabase({ purchase_orders: [{ data: [], error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_recent_purchase_orders', ORG_ID)

    expect(result).toEqual({ count: 0, orders: [] })
  })

  it('returns an error for an unrecognized tool name without touching the DB', async () => {
    const supabase = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('delete_everything', ORG_ID)

    expect(result).toEqual({ error: 'Unknown tool: delete_everything' })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
