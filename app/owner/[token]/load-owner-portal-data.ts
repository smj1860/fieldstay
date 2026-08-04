import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { logAuditEvent } from '@/lib/audit'
import { computeOccupancy } from '@/lib/owner-portal/occupancy'
import type { TxnType } from '@/types/database'
import type { CapExProjectionPayload } from '@/lib/inngest/functions/capex-projections'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { unwrap, unwrapList, type PostgrestResult } from '@/lib/supabase/unwrap'

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

// ── Token validation ─────────────────────────────────────────────────────────

type PortalTokenRow = {
  id:               string
  expires_at:       string | null
  revoked_at:       string | null
  last_accessed_at: string | null
  is_multi:         boolean | null
  property_ids:     string[] | null
  // Supabase returns nested joins as object-or-array; unwrapJoin normalizes.
  property_owners:  unknown
}

const PORTAL_TOKEN_SELECT = `
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
`

type SupabaseLike = ReturnType<typeof createServiceClient>

/**
 * Resolves the opaque portal token. Returns a terminal page state for a
 * revoked/expired/unknown token, or the validated row for the caller to scope
 * every subsequent query against. This IS the only auth this route has.
 */
async function validatePortalToken(
  supabase: SupabaseLike,
  token:    string,
): Promise<{ terminal: OwnerPortalPageState | null; row: PortalTokenRow | null }> {
  const res = await supabase
    .from('owner_portal_tokens')
    .select(PORTAL_TOKEN_SELECT)
    .eq('token', token)
    .maybeSingle()

  // A failed read must not be mistaken for "no such token" — a 404 for a
  // paying owner during an outage is indistinguishable from a revoked link.
  const portalToken = unwrap(res as PostgrestResult<PortalTokenRow>, {
    site: 'owner-portal.validatePortalToken',
  })

  if (!portalToken) return { terminal: null, row: null }
  if (portalToken.revoked_at) return { terminal: { status: 'revoked' }, row: null }
  if (portalToken.expires_at && new Date(portalToken.expires_at) < new Date()) {
    return { terminal: { status: 'expired' }, row: null }
  }
  return { terminal: null, row: portalToken }
}

// ── Portfolio scoping (the tenant-isolation boundary) ────────────────────────

interface PortfolioScope {
  isMulti:             boolean
  portfolioProperties: OwnerPortalProperty[]
  selectedProperty:    string
  viewProperty:        OwnerPortalProperty | null
  /** Property IDs every downstream query is restricted to. Token-derived only. */
  txnPropertyIds:      string[]
}

function resolveSelectedProperty(
  isMulti:       boolean,
  propertyIds:   string[],
  propertyParam: string | undefined,
  fallbackId:    string,
): string {
  if (!isMulti) return fallbackId
  if (propertyParam === 'all') return 'all'
  if (propertyParam !== undefined && propertyIds.includes(propertyParam)) return propertyParam
  return 'all'
}

/**
 * Builds the property scope for this token. `propertyParam` is a URL query
 * value and is therefore untrusted: it can only ever SELECT among the IDs the
 * token already authorizes, never widen them.
 */
async function resolvePortfolioScope(
  supabase:      SupabaseLike,
  portalToken:   PortalTokenRow,
  orgId:         string,
  property:      OwnerPortalProperty,
  propertyParam: string | undefined,
): Promise<PortfolioScope> {
  const isMulti = !!portalToken.is_multi
    && Array.isArray(portalToken.property_ids)
    && portalToken.property_ids.length > 1

  let portfolioProperties: OwnerPortalProperty[] = [property]

  if (isMulti) {
    const props = unwrapList<OwnerPortalProperty>(
      await supabase
        .from('properties')
        .select('id, name, address, city, state, zip')
        .in('id', portalToken.property_ids!)
        .eq('org_id', orgId)   // scope to token's org
        .order('name') as PostgrestResult<OwnerPortalProperty[]>,
      { site: 'owner-portal.portfolioProperties', orgId },
    )
    if (props.length > 0) portfolioProperties = props
  }

  const propertyIds      = portfolioProperties.map((p) => p.id)
  const selectedProperty = resolveSelectedProperty(isMulti, propertyIds, propertyParam, property.id)

  const viewProperty = isMulti
    ? (portfolioProperties.find((p) => p.id === selectedProperty) ?? null)
    : property

  const txnPropertyIds = selectedProperty === 'all'
    ? propertyIds
    : [(viewProperty ?? property).id]

  return { isMulti, portfolioProperties, selectedProperty, viewProperty, txnPropertyIds }
}

// ── Capital plan ─────────────────────────────────────────────────────────────

/**
 * Re-applies tenant isolation to the org-wide capex projection cache. Pure and
 * separately testable precisely because it is the step that, if skipped, leaks
 * a sibling owner's properties into this owner's portal. Mutates in place —
 * the payload is a freshly-parsed jsonb value owned by this request.
 */
function filterCapexToOwnedProperties(
  payload:            CapExProjectionPayload,
  allowedPropertyIds: Set<string>,
): void {
  for (const year of Object.keys(payload.projections)) {
    const proj = payload.projections[Number(year)]!
    proj.items = proj.items.filter((i) => allowedPropertyIds.has(i.property_id))
    proj.total_low  = proj.items.reduce((s, i) => s + i.cost_low, 0)
    proj.total_high = proj.items.reduce((s, i) => s + i.cost_high, 0)
    if (proj.items.length === 0) delete payload.projections[Number(year)]
  }
}

async function loadCapexPayload(
  supabase:       SupabaseLike,
  orgId:          string,
  txnPropertyIds: string[],
  portalTokenId:  string,
): Promise<CapExProjectionPayload | null> {
  const currentYear = new Date().getFullYear()

  const capexMilestone = unwrap(
    await supabase
      .from('org_milestones')
      .select('value')
      .eq('org_id', orgId)
      .eq('milestone', `capex_projection_${currentYear}`)
      .maybeSingle() as PostgrestResult<{ value: unknown }>,
    { site: 'owner-portal.capexMilestone', orgId },
  )

  const payload = (capexMilestone?.value as CapExProjectionPayload | undefined) ?? null
  if (!payload) return null

  filterCapexToOwnedProperties(payload, new Set(txnPropertyIds))

  // Audit: log capital plan view (non-blocking — never throws)
  void logAuditEvent({
    orgId,
    action:     'owner_portal.capital_plan.accessed',
    targetType: 'owner_portal_token',
    targetId:   portalTokenId,
    // No owner name or email in metadata — the token ID is sufficient
    // for investigation without logging PII.
    metadata:   { property_ids: txnPropertyIds },
  })

  return payload
}

// ── Derivations ──────────────────────────────────────────────────────────────

function summarize(txns: OwnerPortalTxn[]): {
  totalRevenue: number; totalExpenses: number; netIncome: number
} {
  let totalRevenue = 0
  let totalExpenses = 0
  for (const t of txns) {
    if ((t.transaction_type as TxnType) === 'revenue') totalRevenue += t.amount
    else if ((t.transaction_type as TxnType) === 'expense') totalExpenses += t.amount
  }
  return { totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses }
}

function groupByProperty(txns: OwnerPortalTxn[]): Map<string, OwnerPortalTxn[]> {
  const byProperty = new Map<string, OwnerPortalTxn[]>()
  for (const t of txns) {
    const list = byProperty.get(t.property_id) ?? []
    list.push(t)
    byProperty.set(t.property_id, list)
  }
  return byProperty
}

function formatAddress(p: OwnerPortalProperty | null): string | null {
  if (!p) return null
  const parts = [p.address, p.city, p.state, p.zip].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

async function recordAccess(
  supabase:      SupabaseLike,
  portalTokenId: string,
  orgId:         string | null,
): Promise<void> {
  await supabase
    .from('owner_portal_tokens')
    .update({ last_accessed_at: new Date().toISOString() })
    .eq('id', portalTokenId)

  if (!orgId) return

  await Promise.all([
    logAuditEvent({
      orgId,
      action:     'owner_portal.accessed',
      targetType: 'owner_portal_token',
      targetId:   portalTokenId,
    }),
    supabase.from('org_milestones').upsert(
      { org_id: orgId, milestone: 'first_owner_portal_view' },
      { onConflict: 'org_id,milestone', ignoreDuplicates: true }
    ),
  ])
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function loadOwnerPortalData(
  token:        string,
  monthParam:   string | undefined,
  propertyParam: string | undefined,
): Promise<OwnerPortalPageState | null> {
  const supabase = createServiceClient({ publicSurface: 'owner--token--load-owner-portal-data' })

  const { terminal, row: portalToken } = await validatePortalToken(supabase, token)
  if (terminal) return terminal
  if (!portalToken) return null

  const ownerRaw = unwrapJoin(portalToken.property_owners) as {
    org_id: string | null
    name: string
    revenue_share_pct: number | null
    share_capital_plan?: boolean
    properties: unknown
  } | null
  if (!ownerRaw) return null

  await recordAccess(supabase, portalToken.id, ownerRaw.org_id)

  const property = unwrapJoin(ownerRaw.properties) as OwnerPortalProperty | null
  if (!property) return null

  const scope = await resolvePortfolioScope(
    supabase, portalToken, ownerRaw.org_id ?? '', property, propertyParam,
  )
  const { txnPropertyIds, selectedProperty, viewProperty } = scope

  // Fetch all visible transactions (last 12 months to cover 6-month picker)
  const since = new Date()
  since.setMonth(since.getMonth() - 11)
  since.setDate(1)

  // Occupancy — a rolling 13-month booking window in one query; current month /
  // same-month-last-year / rolling-12mo are all derived from it.
  const thirteenMonthsAgo = new Date()
  thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13)

  // Both paginated: these are ONE-TO-MANY over the owner's properties, and both
  // span a long window — transactions since `since`, bookings over a rolling 13
  // months. A multi-property owner crosses PostgREST's 1000-row cap easily, and
  // truncation here is not a cosmetic short list: these two reads feed the
  // owner's P&L totals and occupancy percentages. A silently short page renders
  // as UNDERSTATED REVENUE and understated occupancy on a financial statement
  // the owner is given, with nothing indicating it is partial.
  //
  // fetchAllRows throws on a query error, which is the same outcome unwrapList
  // produced here (it throws so the segment's error.tsx renders a real error
  // state rather than an empty portal).
  const [allTxns, bookingsRaw] = await Promise.all([
    fetchAllRows<OwnerPortalTxn>(
      (from, to) => supabase
        .from('owner_transactions')
        .select('id, property_id, transaction_type, category, source, amount, description, transaction_date, notes')
        .in('property_id', txnPropertyIds)
        .eq('visible_to_owner', true)
        .gte('transaction_date', since.toISOString().split('T')[0]!)
        .order('transaction_date', { ascending: false })
        .order('id')
        .range(from, to),
      { label: 'owner-portal.transactions' },
    ),

    fetchAllRows<Parameters<typeof computeOccupancy>[0][number]>(
      (from, to) => supabase
        .from('bookings')
        .select('id, property_id, checkin_date, checkout_date, status')
        .in('property_id', txnPropertyIds)
        .eq('is_block', false)
        .in('status', ['confirmed', 'tentative'])
        .gte('checkout_date', thirteenMonthsAgo.toISOString().split('T')[0]!)
        .order('checkin_date', { ascending: true })
        .order('id')
        .range(from, to),
      { label: 'owner-portal.bookings' },
    ),
  ])

  // Month filter
  const availableMonths  = getLastSixMonths()
  const defaultMonth     = availableMonths[0]!
  const selectedMonth    = availableMonths.includes(monthParam ?? '') ? (monthParam ?? defaultMonth) : defaultMonth

  const filteredTxns = allTxns.filter(
    (t) => toMonthParam(t.transaction_date) === selectedMonth
  )

  const occupancy = computeOccupancy(
    bookingsRaw,
    selectedMonth,
    selectedProperty === 'all' ? txnPropertyIds.length : 1
  )

  const lastYearMonthLabel = formatMonthLabel(
    `${Number(selectedMonth.split('-')[0]) - 1}-${selectedMonth.split('-')[1]}`
  )

  // Capital plan — only if the PM has opted in for this owner
  const shareCapitalPlan = ownerRaw.share_capital_plan ?? false
  const capexPayload = shareCapitalPlan && ownerRaw.org_id
    ? await loadCapexPayload(supabase, ownerRaw.org_id, txnPropertyIds, portalToken.id)
    : null

  const { totalRevenue, totalExpenses, netIncome } = summarize(filteredTxns)

  return {
    status: 'ok',
    data: {
      token,
      portalTokenId:       portalToken.id,
      ownerName:           ownerRaw.name,
      revenueSharePct:     ownerRaw.revenue_share_pct,
      isMulti:             scope.isMulti,
      portfolioProperties: scope.portfolioProperties,
      selectedProperty,
      viewProperty,
      addressDisplay:      formatAddress(viewProperty),
      availableMonths,
      selectedMonth,
      filteredTxns,
      txnsByProperty:      groupByProperty(filteredTxns),
      totalRevenue,
      totalExpenses,
      netIncome,
      occupancy,
      lastYearMonthLabel,
      capexPayload,
    },
  }
}
