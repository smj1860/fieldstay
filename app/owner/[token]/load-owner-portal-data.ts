import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { computeOccupancy } from '@/lib/owner-portal/occupancy'
import type { TxnType } from '@/types/database'
import type { CapExProjectionPayload } from '@/lib/inngest/functions/capex-projections'

/**
 * Data loading for the owner portal page — extracted out of
 * app/owner/[token]/page.tsx so the component itself is pure render. This
 * is the security-sensitive part: it validates the opaque portal token
 * (the only auth this route has — there's no signed-in user), then scopes
 * every subsequent query to the properties/org that token is actually
 * authorized for. `txnPropertyIds` (derived from the server-validated
 * token, never from a query param) is the tenant-isolation boundary
 * re-applied to the capex projections cache below, since that cache is
 * computed org-wide and would otherwise leak sibling properties' data to
 * an owner scoped to only some of them.
 */

export interface OwnerPortalProperty {
  id:      string
  name:    string
  address: string | null
  city:    string | null
  state:   string | null
  zip:     string | null
}

export interface OwnerPortalTxn {
  id:               string
  property_id:      string
  transaction_type: string
  category:         string
  source:           string | null
  amount:           number
  description:      string | null
  transaction_date: string
  notes:            string | null
}

export type OwnerPortalPageState =
  | { status: 'revoked' }
  | { status: 'expired' }
  | { status: 'ok'; data: OwnerPortalData }

export interface OwnerPortalData {
  token:               string
  portalTokenId:        string
  ownerName:            string
  revenueSharePct:      number | null
  isMulti:              boolean
  portfolioProperties:  OwnerPortalProperty[]
  selectedProperty:     string
  viewProperty:         OwnerPortalProperty | null
  addressDisplay:       string | null
  availableMonths:      string[]
  selectedMonth:        string
  filteredTxns:         OwnerPortalTxn[]
  txnsByProperty:       Map<string, OwnerPortalTxn[]>
  totalRevenue:         number
  totalExpenses:        number
  netIncome:            number
  occupancy:            ReturnType<typeof computeOccupancy>
  lastYearMonthLabel:   string
  capexPayload:         CapExProjectionPayload | null
}

function toMonthParam(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function formatMonthLabel(monthParam: string): string {
  const [year, month] = monthParam.split('-')
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
}

function getLastSixMonths(): string[] {
  const months: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return months
}

export async function loadOwnerPortalData(
  token:        string,
  monthParam:   string | undefined,
  propertyParam: string | undefined,
): Promise<OwnerPortalPageState | null> {
  const supabase = createServiceClient()

  // Validate token + fetch owner + property
  const { data: portalToken } = await supabase
    .from('owner_portal_tokens')
    .select(`
      id,
      expires_at,
      revoked_at,
      last_accessed_at,
      is_multi,
      property_ids,
      property_owners (
        id,
        org_id,
        name,
        revenue_share_pct,
        share_capital_plan,
        property_id,
        properties (
          id,
          name,
          address,
          city,
          state,
          zip
        )
      )
    `)
    .eq('token', token)
    .single()

  if (!portalToken) return null

  if (portalToken.revoked_at) return { status: 'revoked' }

  if (portalToken.expires_at && new Date(portalToken.expires_at) < new Date()) {
    return { status: 'expired' }
  }

  // Record access
  await supabase
    .from('owner_portal_tokens')
    .update({ last_accessed_at: new Date().toISOString() })
    .eq('id', portalToken.id)

  const ownerRaw = Array.isArray(portalToken.property_owners)
    ? portalToken.property_owners[0]
    : portalToken.property_owners

  if (!ownerRaw) return null

  if (ownerRaw.org_id) {
    await Promise.all([
      logAuditEvent({
        orgId:      ownerRaw.org_id,
        action:     'owner_portal.accessed',
        targetType: 'owner_portal_token',
        targetId:   portalToken.id,
      }),
      supabase.from('org_milestones').upsert(
        { org_id: ownerRaw.org_id, milestone: 'first_owner_portal_view' },
        { onConflict: 'org_id,milestone', ignoreDuplicates: true }
      ),
    ])
  }

  const property = Array.isArray(ownerRaw.properties)
    ? ownerRaw.properties[0]
    : ownerRaw.properties

  if (!property) return null

  // ── Multi-property portfolio setup ──────────────────────────────────────────
  const isMulti = !!portalToken.is_multi
    && Array.isArray(portalToken.property_ids)
    && portalToken.property_ids.length > 1

  let portfolioProperties: OwnerPortalProperty[] = [property]

  if (isMulti) {
    const { data: props } = await supabase
      .from('properties')
      .select('id, name, address, city, state, zip')
      .in('id', portalToken.property_ids!)
      .eq('org_id', ownerRaw.org_id)   // scope to token's org
      .order('name')

    if (props && props.length > 0) portfolioProperties = props
  }

  const propertyIds      = portfolioProperties.map((p) => p.id)
  const selectedProperty = isMulti
    ? ((propertyParam === 'all' || propertyIds.includes(propertyParam ?? '')) ? (propertyParam ?? 'all') : 'all')
    : property.id

  const viewProperty = isMulti
    ? (portfolioProperties.find((p) => p.id === selectedProperty) ?? null)
    : property

  // Fetch all visible transactions (last 12 months to cover 6-month picker)
  const since = new Date()
  since.setMonth(since.getMonth() - 11)
  since.setDate(1)

  const txnPropertyIds = selectedProperty === 'all' ? propertyIds : [(viewProperty ?? property).id]

  const { data: transactions } = await supabase
    .from('owner_transactions')
    .select('id, property_id, transaction_type, category, source, amount, description, transaction_date, notes')
    .in('property_id', txnPropertyIds)
    .eq('visible_to_owner', true)
    .gte('transaction_date', since.toISOString().split('T')[0]!)
    .order('transaction_date', { ascending: false })

  const allTxns = transactions ?? []

  // Month filter
  const availableMonths  = getLastSixMonths()
  const defaultMonth     = availableMonths[0]!
  const selectedMonth    = availableMonths.includes(monthParam ?? '') ? (monthParam ?? defaultMonth) : defaultMonth

  const filteredTxns = allTxns.filter(
    (t) => toMonthParam(t.transaction_date) === selectedMonth
  )

  // Occupancy — fetch a rolling 13-month booking window in one query and
  // derive current month / same-month-last-year / rolling-12mo from it.
  const thirteenMonthsAgo = new Date()
  thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13)

  const { data: bookingsRaw } = await supabase
    .from('bookings')
    .select('id, property_id, checkin_date, checkout_date, status')
    .in('property_id', txnPropertyIds)
    .eq('is_block', false)
    .in('status', ['confirmed', 'tentative'])
    .gte('checkout_date', thirteenMonthsAgo.toISOString().split('T')[0]!)
    .order('checkin_date', { ascending: true })

  const occupancy = computeOccupancy(
    bookingsRaw ?? [],
    selectedMonth,
    selectedProperty === 'all' ? txnPropertyIds.length : 1
  )

  const lastYearMonthLabel = formatMonthLabel(
    `${Number(selectedMonth.split('-')[0]) - 1}-${selectedMonth.split('-')[1]}`
  )

  // Capital plan — only if PM has opted in for this owner
  const shareCapitalPlan = (ownerRaw as { share_capital_plan?: boolean }).share_capital_plan ?? false

  let capexPayload: CapExProjectionPayload | null = null

  if (shareCapitalPlan && ownerRaw.org_id) {
    const currentYear = new Date().getFullYear()

    const { data: capexMilestone } = await supabase
      .from('org_milestones')
      .select('value')
      .eq('org_id', ownerRaw.org_id)
      .eq('milestone', `capex_projection_${currentYear}`)
      .maybeSingle()

    capexPayload = (capexMilestone?.value as CapExProjectionPayload) ?? null

    if (capexPayload) {
      // Strict tenant isolation: filter to only this owner's properties.
      // property_ids comes from the token (server-validated), never from
      // a user-supplied query parameter.
      const allowedPropertyIds = new Set(txnPropertyIds)

      for (const year of Object.keys(capexPayload.projections)) {
        const proj = capexPayload.projections[Number(year)]!
        proj.items = proj.items.filter((i) => allowedPropertyIds.has(i.property_id))
        proj.total_low  = proj.items.reduce((s, i) => s + i.cost_low, 0)
        proj.total_high = proj.items.reduce((s, i) => s + i.cost_high, 0)
        if (proj.items.length === 0) delete capexPayload.projections[Number(year)]
      }

      // Audit: log capital plan view (non-blocking — never throws)
      void logAuditEvent({
        orgId:      ownerRaw.org_id,
        action:     'owner_portal.capital_plan.accessed',
        targetType: 'owner_portal_token',
        targetId:   portalToken.id,
        // No owner name or email in metadata — the token ID is sufficient
        // for investigation without logging PII.
        metadata:   { property_ids: txnPropertyIds },
      })
    }
  }

  // Summary from filtered transactions
  const totalRevenue  = filteredTxns
    .filter((t) => (t.transaction_type as TxnType) === 'revenue')
    .reduce((s, t) => s + t.amount, 0)
  const totalExpenses = filteredTxns
    .filter((t) => (t.transaction_type as TxnType) === 'expense')
    .reduce((s, t) => s + t.amount, 0)
  const netIncome = totalRevenue - totalExpenses

  const txnsByProperty = new Map<string, OwnerPortalTxn[]>()
  for (const t of filteredTxns) {
    const list = txnsByProperty.get(t.property_id) ?? []
    list.push(t)
    txnsByProperty.set(t.property_id, list)
  }

  const addressParts = viewProperty
    ? [viewProperty.address, viewProperty.city, viewProperty.state, viewProperty.zip].filter(Boolean)
    : []
  const addressDisplay = addressParts.length ? addressParts.join(', ') : null

  return {
    status: 'ok',
    data: {
      token,
      portalTokenId:       portalToken.id,
      ownerName:           ownerRaw.name,
      revenueSharePct:     ownerRaw.revenue_share_pct,
      isMulti,
      portfolioProperties,
      selectedProperty,
      viewProperty,
      addressDisplay,
      availableMonths,
      selectedMonth,
      filteredTxns,
      txnsByProperty,
      totalRevenue,
      totalExpenses,
      netIncome,
      occupancy,
      lastYearMonthLabel,
      capexPayload,
    },
  }
}
