import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { invoices: { list: vi.fn() } },
}))

import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import {
  getPlanStatus,
  getRecentTurnovers,
  getIntegrationStatus,
  getRecentPurchaseOrders,
  getWorkOrderStatus,
  getVendorComplianceStatus,
  getCrewRosterStatus,
  getBelowParInventory,
  getBillingDetails,
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
    for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'limit', 'in']) {
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

  it('declares exactly the nine tools callAccountTool knows how to dispatch', () => {
    const names = ACCOUNT_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([
      'get_below_par_inventory', 'get_billing_details', 'get_crew_roster_status',
      'get_integration_status', 'get_plan_status', 'get_recent_purchase_orders',
      'get_recent_turnovers', 'get_vendor_compliance_status', 'get_work_order_status',
    ])
  })
})

describe('getWorkOrderStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps a vendor-assigned work order, marking it dispatched when a dispatch email is on file', async () => {
    const supabase = makeSupabase({
      work_orders: [{
        data: [{
          wo_number: 'WO-1', title: 'Fix HVAC', status: 'in_progress', priority: 'high',
          scheduled_date: '2026-08-01', completed_date: null, nte_amount: 500, actual_cost: null,
          vendor_dispatch_email: 'vendor@example.com', assigned_crew_member_id: null,
          properties: [{ name: 'Lakeside Lodge' }], vendors: [{ name: 'Cool Air Co' }],
        }],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getWorkOrderStatus(ORG_ID)

    expect(result).toEqual({
      count: 1,
      workOrders: [{
        workOrderNumber: 'WO-1', title: 'Fix HVAC', property: 'Lakeside Lodge',
        status: 'in_progress', priority: 'high', assignedTo: 'Cool Air Co',
        dispatchedToVendor: true, scheduledDate: '2026-08-01', completedDate: null,
        nteAmount: 500, actualCost: null,
      }],
    })
    // No crew lookup needed when nothing has an assigned_crew_member_id
    expect(supabase.calls.some((c) => c.table === 'crew_members')).toBe(false)
  })

  it('resolves a crew-assigned work order name via a batched crew_members lookup', async () => {
    const supabase = makeSupabase({
      work_orders: [{
        data: [{
          wo_number: 'WO-2', title: 'Replace lockbox', status: 'assigned', priority: 'low',
          scheduled_date: null, completed_date: null, nte_amount: null, actual_cost: null,
          vendor_dispatch_email: null, assigned_crew_member_id: 'crew_1',
          properties: [{ name: 'Mountain Cabin' }], vendors: null,
        }],
        error: null,
      }],
      crew_members: [{ data: [{ id: 'crew_1', name: 'Alex Rivera' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getWorkOrderStatus(ORG_ID)

    if ('error' in result) throw new Error('expected a work orders result')
    expect(result.workOrders[0]?.assignedTo).toBe('Alex Rivera')
    expect(result.workOrders[0]?.dispatchedToVendor).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'crew_members' && c.method === 'in' && c.args[1]?.[0] === 'crew_1')).toBe(true)
  })

  it('reports Unassigned when neither a vendor nor a crew member is on the work order', async () => {
    const supabase = makeSupabase({
      work_orders: [{
        data: [{
          wo_number: 'WO-3', title: 'Inspect roof', status: 'pending', priority: 'medium',
          scheduled_date: null, completed_date: null, nte_amount: null, actual_cost: null,
          vendor_dispatch_email: null, assigned_crew_member_id: null,
          properties: [{ name: 'Ridge House' }], vendors: null,
        }],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getWorkOrderStatus(ORG_ID)

    if ('error' in result) throw new Error('expected a work orders result')
    expect(result.workOrders[0]?.assignedTo).toBe('Unassigned')
  })

  it('scopes to the given org, excludes cancelled work orders, and returns an error message on a query error', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: null, error: { message: 'db down' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getWorkOrderStatus(ORG_ID)

    expect(result).toEqual({ error: 'Could not fetch work orders.' })
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'neq' && c.args[0] === 'status' && c.args[1] === 'cancelled')).toBe(true)
  })
})

describe('getVendorComplianceStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps vendor compliance rows scoped to the given org', async () => {
    const supabase = makeSupabase({
      vendor_compliance_status: [{
        data: [{
          vendor_name: 'Cool Air Co', compliance_status: 'grace_period',
          expired_doc_count: 1, expiring_soon_count: 0, days_past_expiry: 12,
        }],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getVendorComplianceStatus(ORG_ID)

    expect(result).toEqual({
      count: 1,
      vendors: [{
        name: 'Cool Air Co', complianceStatus: 'grace_period',
        expiredDocCount: 1, expiringSoonCount: 0, daysPastExpiry: 12,
      }],
    })
  })

  it('returns an error message on a query error', async () => {
    const supabase = makeSupabase({
      vendor_compliance_status: [{ data: null, error: { message: 'boom' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getVendorComplianceStatus(ORG_ID)

    expect(result).toEqual({ error: 'Could not fetch vendor compliance status.' })
  })
})

describe('getCrewRosterStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('classifies invite status as not_invited, pending, or accepted', async () => {
    const supabase = makeSupabase({
      crew_members: [{
        data: [
          { name: 'Not Invited', role: 'cleaning', is_active: true, invite_sent_at: null, invite_accepted_at: null },
          { name: 'Pending',     role: 'cleaning', is_active: true, invite_sent_at: '2026-07-01T00:00:00Z', invite_accepted_at: null },
          { name: 'Accepted',    role: 'general',  is_active: true, invite_sent_at: '2026-07-01T00:00:00Z', invite_accepted_at: '2026-07-02T00:00:00Z' },
        ],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getCrewRosterStatus(ORG_ID)

    if ('error' in result) throw new Error('expected a crew roster result')
    expect(result.crew.map((c) => c.inviteStatus)).toEqual(['not_invited', 'pending', 'accepted'])
  })

  it('returns an error message on a query error', async () => {
    const supabase = makeSupabase({
      crew_members: [{ data: null, error: { message: 'boom' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getCrewRosterStatus(ORG_ID)

    expect(result).toEqual({ error: 'Could not fetch crew roster.' })
  })
})

describe('getBelowParInventory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('only includes counted items that are actually below par', async () => {
    const supabase = makeSupabase({
      inventory_items: [{
        data: [
          { name: 'Paper Towels', current_quantity: 1, par_level: 4, first_count_recorded_at: '2026-07-01T00:00:00Z', properties: { name: 'Lakeside Lodge' } },
          { name: 'Dish Soap',    current_quantity: 5, par_level: 4, first_count_recorded_at: '2026-07-01T00:00:00Z', properties: { name: 'Lakeside Lodge' } },
          { name: 'Trash Bags',   current_quantity: 0, par_level: 2, first_count_recorded_at: null, properties: { name: 'Mountain Cabin' } },
        ],
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getBelowParInventory(ORG_ID)

    expect(result).toEqual({
      count: 1,
      items: [{ item: 'Paper Towels', property: 'Lakeside Lodge', currentQuantity: 1, parLevel: 4 }],
    })
  })

  it('returns an error message on a query error', async () => {
    const supabase = makeSupabase({
      inventory_items: [{ data: null, error: { message: 'boom' } }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getBelowParInventory(ORG_ID)

    expect(result).toEqual({ error: 'Could not fetch inventory.' })
  })
})

describe('getBillingDetails', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a null invoice when the org has no Stripe customer yet', async () => {
    const supabase = makeSupabase({
      organizations: [{
        data: { plan: 'starter', plan_status: 'trialing', trial_ends_at: '2026-08-01', max_properties: 15, stripe_customer_id: null },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getBillingDetails(ORG_ID)

    expect(result).toEqual({
      plan: 'starter', planStatus: 'trialing', trialEndsAt: '2026-08-01', maxProperties: 15,
      recentInvoice: null,
    })
    expect(stripe.invoices.list).not.toHaveBeenCalled()
  })

  it('maps the most recent Stripe invoice when a customer is on file', async () => {
    const supabase = makeSupabase({
      organizations: [{
        data: { plan: 'growth', plan_status: 'active', trial_ends_at: null, max_properties: 50, stripe_customer_id: 'cus_1' },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(stripe.invoices.list).mockResolvedValue({
      data: [{
        status: 'open', amount_due: 47900, amount_paid: 0,
        due_date: 1785715200, hosted_invoice_url: 'https://invoice.stripe.com/i/1',
      }],
    } as never)

    const result = await getBillingDetails(ORG_ID)

    expect(result).toMatchObject({
      plan: 'growth', planStatus: 'active',
      recentInvoice: {
        status: 'open', amountDue: 479, amountPaid: 0,
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/1',
      },
    })
    expect(stripe.invoices.list).toHaveBeenCalledWith({ customer: 'cus_1', limit: 1 })
  })

  it('degrades gracefully with a billingLookupError when Stripe is unreachable', async () => {
    const supabase = makeSupabase({
      organizations: [{
        data: { plan: 'growth', plan_status: 'active', trial_ends_at: null, max_properties: 50, stripe_customer_id: 'cus_1' },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(stripe.invoices.list).mockRejectedValue(new Error('network error'))

    const result = await getBillingDetails(ORG_ID)

    expect(result).toMatchObject({ recentInvoice: null, billingLookupError: expect.any(String) })
  })

  it('returns an error when the organization is not found', async () => {
    const supabase = makeSupabase({ organizations: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await getBillingDetails(ORG_ID)

    expect(result).toEqual({ error: 'Could not find billing information.' })
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

  it('dispatches get_work_order_status', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: [], error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_work_order_status', ORG_ID)

    expect(result).toEqual({ count: 0, workOrders: [] })
  })

  it('dispatches get_vendor_compliance_status', async () => {
    const supabase = makeSupabase({ vendor_compliance_status: [{ data: [], error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_vendor_compliance_status', ORG_ID)

    expect(result).toEqual({ count: 0, vendors: [] })
  })

  it('dispatches get_crew_roster_status', async () => {
    const supabase = makeSupabase({ crew_members: [{ data: [], error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_crew_roster_status', ORG_ID)

    expect(result).toEqual({ count: 0, crew: [] })
  })

  it('dispatches get_below_par_inventory', async () => {
    const supabase = makeSupabase({ inventory_items: [{ data: [], error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_below_par_inventory', ORG_ID)

    expect(result).toEqual({ count: 0, items: [] })
  })

  it('dispatches get_billing_details', async () => {
    const supabase = makeSupabase({
      organizations: [{
        data: { plan: 'starter', plan_status: 'trialing', trial_ends_at: null, max_properties: 15, stripe_customer_id: null },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('get_billing_details', ORG_ID)

    expect(result).toMatchObject({ plan: 'starter', recentInvoice: null })
  })

  it('returns an error for an unrecognized tool name without touching the DB', async () => {
    const supabase = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await callAccountTool('delete_everything', ORG_ID)

    expect(result).toEqual({ error: 'Unknown tool: delete_everything' })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
