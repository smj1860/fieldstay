import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { stripe } from '@/lib/stripe/client'
import { reportError } from '@/lib/observability/report-error'
import { reportQueryError, tryUnwrapList } from '@/lib/supabase/unwrap'

/**
 * Account-specific data tools for the support bot.
 * Every function takes orgId as a parameter that is ALWAYS derived server-side
 * from the authenticated session — never from the model's tool call arguments
 * or the request body. This mirrors the org_id scoping rule used everywhere
 * else in the codebase (Server Actions, Inngest functions, RLS policies).
 */

export async function getPlanStatus(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('plan_status, plan, created_at')
    .eq('id', orgId)
    .single()

  const { count: propertyCount } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('is_active', true)

  const { count: activeSponsorCount } = await supabase
    .from('guidebook_sponsors')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'active')

  if (reportQueryError(orgError, { site: 'lib.support.account-tools.getPlanStatus', orgId }) || !org) {
    return { error: 'Could not find account information.' }
  }

  return {
    plan:                org.plan,
    planStatus:          org.plan_status,
    accountCreated:      org.created_at,
    activePropertyCount: propertyCount ?? 0,
    activeSponsorCount:  activeSponsorCount ?? 0,
  }
}

export async function getRecentTurnovers(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('turnovers')
    .select(`
      id, status, checkin_datetime, checkout_datetime, is_same_day_turnover,
      properties ( name )
    `)
    .eq('org_id', orgId)
    .gte('checkout_datetime', sevenDaysAgo)
    .lte('checkin_datetime', sevenDaysOut)
    .order('checkout_datetime', { ascending: true })
    .limit(15)

  if (error) return { error: 'Could not fetch turnovers.' }

  return {
    count: data?.length ?? 0,
    turnovers: (data ?? []).map((t) => ({
      property:    unwrapJoin(t.properties)?.name,
      status:      t.status,
      checkout:    t.checkout_datetime,
      checkin:     t.checkin_datetime,
      sameDayFlip: t.is_same_day_turnover,
    })),
  }
}

export async function getIntegrationStatus(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  const { data, error } = await supabase
    .from('integration_connections')
    .select('provider_id, status, last_used_at, connected_at, integration_providers ( display_name )')
    .eq('org_id', orgId)

  if (error) return { error: 'Could not fetch integration status.' }

  return {
    connections: (data ?? []).map((c) => ({
      provider:    unwrapJoin(c.integration_providers)?.display_name ?? c.provider_id,
      status:      c.status,
      lastUsedAt:  c.last_used_at,
      connectedAt: c.connected_at,
    })),
  }
}

export async function getRecentPurchaseOrders(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('purchase_orders')
    .select(`
      id, created_at, order_email_sent, is_same_day_flip,
      properties ( name )
    `)
    .eq('org_id', orgId)
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) return { error: 'Could not fetch purchase orders.' }

  return {
    count: data?.length ?? 0,
    orders: (data ?? []).map((po) => ({
      property:    unwrapJoin(po.properties)?.name,
      createdAt:   po.created_at,
      emailSent:   po.order_email_sent,
      sameDayFlip: po.is_same_day_flip,
    })),
  }
}

export async function getWorkOrderStatus(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  const { data, error } = await supabase
    .from('work_orders')
    .select(`
      wo_number, title, status, priority, scheduled_date, completed_date,
      nte_amount, actual_cost, vendor_dispatch_email, assigned_crew_member_id,
      properties ( name ),
      vendors ( name )
    `)
    .eq('org_id', orgId)
    .neq('status', 'cancelled')
    .order('updated_at', { ascending: false })
    .limit(15)

  if (error) return { error: 'Could not fetch work orders.' }

  // Batched lookup, not a per-row query — assigned_crew_member_id has two
  // FK targets on work_orders (assigned vs. reported-by), so a nested
  // `crew_members ( name )` embed is ambiguous; resolve it with one .in()
  // call instead, same pattern as app/(dashboard)/maintenance/page.tsx.
  const crewIds = Array.from(
    new Set(
      (data ?? [])
        .map((wo) => wo.assigned_crew_member_id)
        .filter((id): id is string => id !== null)
    )
  )

  const crewNameById = new Map<string, string>()
  if (crewIds.length) {
    const crewRes = await supabase
      .from('crew_members')
      .select('id, name')
      .eq('org_id', orgId)
      .in('id', crewIds)
      .limit(crewIds.length)
    const crewOut = tryUnwrapList(crewRes, {
      site: 'lib.support.account-tools.getWorkOrderStatus.crewLookup',
      orgId,
    })
    if (crewOut.ok) {
      for (const c of crewOut.data) crewNameById.set(c.id, c.name)
    }
  }

  return {
    count: data?.length ?? 0,
    workOrders: (data ?? []).map((wo) => ({
      workOrderNumber: wo.wo_number,
      title:           wo.title,
      property:        unwrapJoin(wo.properties)?.name,
      status:          wo.status,
      priority:        wo.priority,
      assignedTo:      unwrapJoin(wo.vendors)?.name
                          ?? (wo.assigned_crew_member_id ? crewNameById.get(wo.assigned_crew_member_id) : undefined)
                          ?? 'Unassigned',
      dispatchedToVendor: wo.vendor_dispatch_email !== null,
      scheduledDate:      wo.scheduled_date,
      completedDate:      wo.completed_date,
      nteAmount:          wo.nte_amount,
      actualCost:         wo.actual_cost,
    })),
  }
}

export async function getVendorComplianceStatus(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  const { data, error } = await supabase
    .from('vendor_compliance_status')
    .select('vendor_name, compliance_status, expired_doc_count, expiring_soon_count, days_past_expiry')
    .eq('org_id', orgId)
    .order('vendor_name', { ascending: true })
    .limit(30)

  if (error) return { error: 'Could not fetch vendor compliance status.' }

  return {
    count: data?.length ?? 0,
    vendors: (data ?? []).map((v) => ({
      name:              v.vendor_name,
      complianceStatus:  v.compliance_status,
      expiredDocCount:   v.expired_doc_count,
      expiringSoonCount: v.expiring_soon_count,
      daysPastExpiry:    v.days_past_expiry,
    })),
  }
}

export async function getCrewRosterStatus(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  const { data, error } = await supabase
    .from('crew_members')
    .select('name, role, is_active, invite_sent_at, invite_accepted_at')
    .eq('org_id', orgId)
    .order('name', { ascending: true })
    .limit(50)

  if (error) return { error: 'Could not fetch crew roster.' }

  return {
    count: data?.length ?? 0,
    crew: (data ?? []).map((c) => ({
      name:   c.name,
      role:   c.role,
      active: c.is_active,
      inviteStatus: (() => {
        if (!c.invite_sent_at) return 'not_invited'
        return c.invite_accepted_at ? 'accepted' : 'pending'
      })(),
    })),
  }
}

export async function getBelowParInventory(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  const { data, error } = await supabase
    .from('inventory_items')
    .select('name, current_quantity, par_level, first_count_recorded_at, properties ( name )')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .limit(300)

  if (error) return { error: 'Could not fetch inventory.' }

  // supabase.raw() doesn't exist on this client — column-to-column
  // comparison (current_quantity < par_level) has to happen in JS, not SQL.
  const belowPar = (data ?? [])
    .filter((i) => i.first_count_recorded_at && i.current_quantity < i.par_level)
    .slice(0, 20)

  return {
    count: belowPar.length,
    items: belowPar.map((i) => ({
      item:            i.name,
      property:        unwrapJoin(i.properties)?.name,
      currentQuantity: i.current_quantity,
      parLevel:        i.par_level,
    })),
  }
}

export async function getBillingDetails(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('plan, plan_status, trial_ends_at, max_properties, stripe_customer_id')
    .eq('id', orgId)
    .single()

  if (reportQueryError(orgError, { site: 'lib.support.account-tools.getBillingDetails', orgId }) || !org) {
    return { error: 'Could not find billing information.' }
  }

  const base = {
    plan:          org.plan,
    planStatus:    org.plan_status,
    trialEndsAt:   org.trial_ends_at,
    maxProperties: org.max_properties,
  }

  if (!org.stripe_customer_id) return { ...base, recentInvoice: null }

  try {
    const invoices = await stripe.invoices.list({ customer: org.stripe_customer_id, limit: 1 })
    const invoice  = invoices.data[0]

    if (!invoice) return { ...base, recentInvoice: null }

    return {
      ...base,
      recentInvoice: {
        status:           invoice.status,
        amountDue:        invoice.amount_due / 100,
        amountPaid:       invoice.amount_paid / 100,
        dueDate:          invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().split('T')[0] : null,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
      },
    }
  } catch (err) {
    console.error('[getBillingDetails] Stripe invoice lookup failed')
    reportError(err, { site: 'lib.support.account-tools.getBillingDetails' })
    return { ...base, recentInvoice: null, billingLookupError: 'Could not reach Stripe for the latest invoice.' }
  }
}

/**
 * Tool definitions for the Anthropic SDK tool-use API.
 * Each tool takes NO model-supplied arguments — orgId is injected server-side
 * when the tool is actually called, never read from what the model passes.
 */
export const ACCOUNT_TOOLS = [
  {
    name:         'get_plan_status',
    description:  'Get the current plan, billing status, active property count, and active guidebook sponsor count for this account.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name:         'get_recent_turnovers',
    description:  'Get turnovers from the last 7 days through the next 7 days, including status and same-day flip flags.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name:         'get_integration_status',
    description:  'Get the connection status and last used time for all connected integrations (OwnerRez, Hostaway, etc.).',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name:         'get_recent_purchase_orders',
    description:  'Get purchase orders created in the last 7 days, including whether the restock email was sent.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name:         'get_work_order_status',
    description:  'Get open and recently-updated work orders — property, status, priority, whether it was dispatched to a vendor or assigned to crew, scheduled/completed dates, and cost.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name:         'get_vendor_compliance_status',
    description:  'Get every vendor\'s compliance status (compliant, expiring soon, grace period, or hard-blocked) and document expiry details.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name:         'get_crew_roster_status',
    description:  'Get the crew roster with each member\'s active/inactive state and invite status (not invited, pending, or accepted) — for questions about a crew member not being able to log in or see their turnovers.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name:         'get_below_par_inventory',
    description:  'Get inventory items currently counted below their par level across all properties.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name:         'get_billing_details',
    description:  'Get plan, trial end date, property limit, and the most recent Stripe invoice (status, amount due/paid, due date, and a link to it) for this account.',
    input_schema: { type: 'object' as const, properties: {} },
  },
]

/**
 * Dispatches a tool call by name. orgId comes from the caller (the API route,
 * which derived it from the authenticated session) — never from the tool call
 * arguments the model produced.
 */
export async function callAccountTool(toolName: string, orgId: string) {
  switch (toolName) {
    case 'get_plan_status':              return getPlanStatus(orgId)
    case 'get_recent_turnovers':         return getRecentTurnovers(orgId)
    case 'get_integration_status':       return getIntegrationStatus(orgId)
    case 'get_recent_purchase_orders':   return getRecentPurchaseOrders(orgId)
    case 'get_work_order_status':        return getWorkOrderStatus(orgId)
    case 'get_vendor_compliance_status': return getVendorComplianceStatus(orgId)
    case 'get_crew_roster_status':       return getCrewRosterStatus(orgId)
    case 'get_below_par_inventory':      return getBelowParInventory(orgId)
    case 'get_billing_details':          return getBillingDetails(orgId)
    default:                             return { error: `Unknown tool: ${toolName}` }
  }
}
