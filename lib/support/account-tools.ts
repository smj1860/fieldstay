import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { stripe } from '@/lib/stripe/client'
import { reportError } from '@/lib/observability/report-error'
import { reportQueryError, tryUnwrapList } from '@/lib/supabase/unwrap'
import {
  resolvePar,
  DEFAULT_STAY_LENGTH_NIGHTS,
  STAY_LENGTH_MIN_BOOKINGS,
  type ParSmartGroup,
} from '@/lib/inventory/par-engine'

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

/**
 * "Why is my washcloth par 16?"
 *
 * This question cannot be answered from the help docs, and that is the reason
 * this tool exists rather than another paragraph in docs/support. A smart par
 * is computed per property from that property's own bathroom / bedroom / guest
 * count, the item's base quantity, whether the PM has re-based it by hand, and
 * how many consumption samples the property has recorded. No document can
 * state the number, because the number is different for every property and
 * changes when the property does.
 *
 * SEARCH TERM IS A FILTER, NOT A SCOPE. Unlike the other tools this one takes
 * a model-supplied argument, which is safe here precisely because it can only
 * ever NARROW an already org-scoped query — orgId still comes from the
 * authenticated session and is never read from the tool call. The term is
 * passed to .ilike() as a value (URL-encoded by the client), never
 * concatenated into a filter string.
 *
 * The explanation is written HERE, in plain English, rather than left for the
 * model to derive from raw config. A PM asking this question does not want
 * base_qty and a buffer coefficient; they want a sentence. Handing the model
 * the sentence also stops it inventing arithmetic.
 *
 * The branch label comes from resolvePar()'s own `source`, not from
 * re-deriving the priority rules here. If the engine's resolution order ever
 * changes, this explanation changes with it instead of quietly lying.
 */
export async function getParLevelExplanation(orgId: string, searchTerm?: string) {
  const supabase = createServiceClient({ system: 'lib/support/account-tools' })

  // Escaped exactly as the vendor lookup in app/actions/work-order-public.ts
  // does, and for the same reason recorded there: an unescaped '%' matches
  // every row, so a model emitting one would describe the whole portfolio
  // while appearing to answer about one item.
  const term = (searchTerm ?? '').trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)

  // ONE chain, with .ilike() applied unconditionally — an empty term gives
  // '%%', which matches everything. Building this conditionally and awaiting a
  // reassigned variable put the .limit() out of the query's lexical scope, so
  // semgrep's unbounded-select rule could not see the bound and failed CI on a
  // read that was in fact bounded. Keeping the whole chain in one expression
  // means the limit is visible to the checker as well as to a reader.
  const itemsRes = await supabase
    .from('inventory_items')
    .select('id, name, par_level, par_mode, smart_group, base_qty, auto_adjust, property_id, properties ( name, bedrooms, bathrooms, max_guests )')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .ilike('name', `%${term}%`)
    .limit(PAR_EXPLANATION_LIMIT)
  if (reportQueryError(itemsRes.error, { site: 'lib.support.accountTools.getParLevelExplanation', orgId })) {
    return { error: 'Could not look up par levels.' }
  }
  const items = itemsRes.data ?? []
  if (!items.length) {
    return { matched: 0, items: [], note: searchTerm ? `No active inventory item matching "${searchTerm}".` : 'No active inventory items.' }
  }

  // Consumption stats decide whether resolvePar takes the historical branch.
  // Fetched for the matched items only, so this stays bounded by the limit above.
  const statsRes = await supabase
    .from('inventory_consumption_stats')
    .select('inventory_item_id, avg_rate_per_guest_night, sample_count')
    .eq('org_id', orgId)
    .in('inventory_item_id', items.map((i) => i.id))
    .limit(PAR_EXPLANATION_LIMIT)
  const stats = tryUnwrapList(statsRes, { site: 'lib.support.accountTools.getParLevelExplanation.stats' })
  const statsByItem = new Map(
    (stats.ok ? stats.data : []).map((s) => [s.inventory_item_id as string, s]),
  )

  // Same derived stay length the engine uses, so a historical explanation
  // quotes the nights the engine actually multiplied by.
  const stayRes = await supabase.rpc('derive_property_stay_lengths', {
    p_org_id: orgId, p_property_ids: [...new Set(items.map((i) => i.property_id))],
  })
  const stayByProperty = new Map<string, number>()
  if (Array.isArray(stayRes.data)) {
    for (const r of stayRes.data) {
      if (r.sample_count >= STAY_LENGTH_MIN_BOOKINGS) stayByProperty.set(r.property_id, Number(r.avg_nights))
    }
  }

  return {
    matched: items.length,
    items: items.map((i) => {
      const p = unwrapJoin(i.properties)
      const property = {
        bedrooms:        p?.bedrooms   && p.bedrooms   > 0 ? p.bedrooms   : 1,
        bathrooms:       p?.bathrooms  && p.bathrooms  > 0 ? p.bathrooms  : 1,
        max_guests:      p?.max_guests && p.max_guests > 0 ? p.max_guests : 2,
        avg_stay_length: stayByProperty.get(i.property_id) ?? null,
      }
      const s = statsByItem.get(i.id)
      const consumption = s
        ? { avg_rate_per_guest_night: Number(s.avg_rate_per_guest_night), sample_count: Number(s.sample_count) }
        : null

      const resolved = resolvePar(
        {
          par_mode:    i.par_mode,
          smart_group: i.smart_group,
          base_qty:    Number(i.base_qty),
          par_level:   Number(i.par_level),
          auto_adjust: i.auto_adjust,
        },
        property,
        consumption,
      )

      return {
        item:     i.name,
        property: p?.name ?? 'Unknown property',
        parLevel: Number(i.par_level),
        ...explainPar(resolved.source, i, property, consumption),
      }
    }),
  }
}

const PAR_EXPLANATION_LIMIT = 25

/**
 * Wording for the property attribute a smart group scales by.
 *
 * plural and singular are stored separately rather than derived by stripping
 * an "s": "guest capacity" is not the plural of "guest", and naive stripping
 * produced "about 4.5 per guests it sleep" in review.
 */
const SCALES_BY: Record<ParSmartGroup, {
  plural: string; singular: string; key: 'bathrooms' | 'bedrooms' | 'max_guests'
}> = {
  bathroom_essential: { plural: 'bathrooms',      singular: 'bathroom', key: 'bathrooms' },
  bedroom_essential:  { plural: 'bedrooms',       singular: 'bedroom',  key: 'bedrooms' },
  guest_consumable:   { plural: 'guest capacity', singular: 'guest',    key: 'max_guests' },
}

/**
 * A plain sentence a PM can act on, plus what to change to move the number.
 *
 * Written for someone with no interest in how the engine works: no
 * "base_qty", no "multiplier", no percentages presented as coefficients.
 */
function explainPar(
  source:      'static' | 'historical' | 'smart_formula',
  item:        { par_level: number; smart_group: ParSmartGroup | null; auto_adjust: boolean },
  property:    { bathrooms: number; bedrooms: number; max_guests: number; avg_stay_length: number | null },
  consumption: { avg_rate_per_guest_night: number; sample_count: number } | null,
): { setBy: string; explanation: string; whatChangesIt: string } {
  const par = Number(item.par_level)

  if (source === 'historical' && consumption) {
    const nights = property.avg_stay_length ?? DEFAULT_STAY_LENGTH_NIGHTS
    const nightsNote = property.avg_stay_length
      ? `an average stay of ${nights.toFixed(1)} nights at this property`
      : `an assumed ${nights}-night stay (this property does not have enough bookings yet to measure its own average)`
    return {
      setBy: 'learned from actual usage',
      explanation:
        `The par level is ${par}. FieldStay worked this out from what this property actually goes through: ` +
        `${consumption.sample_count} inventory counts, ${property.max_guests} guests, and ${nightsNote}, ` +
        `plus a 20% buffer so you do not run out.`,
      whatChangesIt:
        'It updates on its own as more counts come in. To override it, type the number you want on the inventory page.',
    }
  }

  if (source === 'smart_formula' && item.smart_group) {
    const { plural, singular, key } = SCALES_BY[item.smart_group]
    const count   = property[key]
    const perUnit = Math.round((par / count) * 10) / 10
    const touched = !item.auto_adjust
    return {
      setBy: `scales with ${plural}`,
      explanation:
        `The par level is ${par}. It scales with the property's ${plural} — this one has ${count} — ` +
        `which works out to about ${perUnit} per ${singular}, including a safety buffer. ` +
        (touched
          ? 'You set this level yourself, and it will keep adjusting from your number if the property changes.'
          : 'It is on the FieldStay default and will adjust automatically if the property changes.'),
      whatChangesIt:
        `Update the property's ${plural} to rescale it, or type the number you want on the inventory page and it will scale from there.`,
    }
  }

  return {
    setBy: 'fixed number',
    explanation:
      `The par level is ${par}. This is a fixed number — it does not scale with the property's size ` +
      'and does not change on its own.',
    whatChangesIt: 'Type a new number on the inventory page.',
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
    name:        'get_par_level_explanation',
    description:
      'Explain WHY an inventory item has the par level it has at a property — whether it scales with ' +
      'bathrooms, bedrooms or guest count, was learned from actual usage, or is a fixed number, and what ' +
      'the PM would change to move it. Use this for any "why is my par level X", "how is this calculated", ' +
      '"my par level looks wrong", or "why did my par change" question. Returns a plain-English explanation ' +
      'per matching item. Pass item_name to narrow to one item; omit it to describe the whole portfolio.',
    input_schema: {
      type: 'object' as const,
      properties: {
        item_name: {
          type:        'string' as const,
          description: 'Optional. Part of the item name to look for, e.g. "washcloth" or "towel".',
        },
      },
    },
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
export async function callAccountTool(toolName: string, orgId: string, toolInput?: unknown) {
  switch (toolName) {
    // The ONLY tool taking model-supplied input, and it is read defensively:
    // a non-string (the model can emit anything) degrades to undefined, which
    // means "whole portfolio" rather than a crash or a coerced "[object
    // Object]" search. It narrows an org-scoped query and cannot widen it —
    // orgId still comes from the session, never from here.
    case 'get_par_level_explanation': {
      const raw = (toolInput as { item_name?: unknown } | undefined)?.item_name
      return getParLevelExplanation(orgId, typeof raw === 'string' ? raw.slice(0, 100) : undefined)
    }
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
