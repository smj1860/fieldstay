import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapJoin } from '@/lib/utils/supabase-joins'

/**
 * Account-specific data tools for the support bot.
 * Every function takes orgId as a parameter that is ALWAYS derived server-side
 * from the authenticated session — never from the model's tool call arguments
 * or the request body. This mirrors the org_id scoping rule used everywhere
 * else in the codebase (Server Actions, Inngest functions, RLS policies).
 */

export async function getPlanStatus(orgId: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  const { data: org } = await supabase
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

  if (!org) return { error: 'Could not find account information.' }

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
]

/**
 * Dispatches a tool call by name. orgId comes from the caller (the API route,
 * which derived it from the authenticated session) — never from the tool call
 * arguments the model produced.
 */
export async function callAccountTool(toolName: string, orgId: string) {
  switch (toolName) {
    case 'get_plan_status':            return getPlanStatus(orgId)
    case 'get_recent_turnovers':       return getRecentTurnovers(orgId)
    case 'get_integration_status':     return getIntegrationStatus(orgId)
    case 'get_recent_purchase_orders': return getRecentPurchaseOrders(orgId)
    default:                           return { error: `Unknown tool: ${toolName}` }
  }
}
