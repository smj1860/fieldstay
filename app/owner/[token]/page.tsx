import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import type { Metadata } from 'next'
import type { TxnType } from '@/types/database'

export const metadata: Metadata = { title: 'Owner Portal — FieldStay' }

interface Props {
  params:       Promise<{ token: string }>
  searchParams: Promise<{ month?: string; property?: string }>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              'USD',
    minimumFractionDigits: 2,
  }).format(amount)
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

function formatDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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

// ── Source badge config ───────────────────────────────────────────────────────

type BadgeColor = 'blue' | 'amber'

interface SourceBadge {
  label:    string
  color:    BadgeColor
  tooltip?: string
}

const SOURCE_BADGES: Record<string, SourceBadge | null> = {
  manual:             null,
  booking_revenue:    { label: 'Booking',        color: 'blue'  },
  uplisting_booking:  { label: 'Booking (Est.)', color: 'blue',  tooltip: 'Estimated from average nightly rate' },
  wo_completion:      { label: 'Work Order',      color: 'amber' },
  cleaning_fee:       { label: 'Cleaning',        color: 'amber' },
  inventory_purchase: { label: 'Supplies',        color: 'amber' },
}

const SOURCE_FALLBACK_LABELS: Record<string, string> = {
  booking_revenue:    'Booking Revenue',
  uplisting_booking:  'Booking (Uplisting)',
  wo_completion:      'Work Order Completion',
  cleaning_fee:       'Cleaning Fee',
  inventory_purchase: 'Supply Purchase',
  manual:             'Manual Entry',
}

const BADGE_STYLES: Record<BadgeColor, string> = {
  blue:  'bg-blue-50 text-blue-700 border border-blue-200',
  amber: 'bg-amber-50 text-amber-700 border border-amber-200',
}

interface TxnRowData {
  id:               string
  transaction_type: string
  category:         string
  source:           string | null
  amount:           number
  description:      string | null
  transaction_date: string
  notes:            string | null
}

function TransactionRow({ txn }: { txn: TxnRowData }) {
  const isRevenue = (txn.transaction_type as TxnType) === 'revenue'
  const badge     = SOURCE_BADGES[txn.source ?? ''] ?? null
  const desc      = txn.description || SOURCE_FALLBACK_LABELS[txn.source ?? ''] || txn.category

  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      {/* Date */}
      <div className="w-16 flex-shrink-0 text-xs text-gray-400 tabular-nums">
        {formatDate(txn.transaction_date)}
      </div>

      {/* Description + source badge */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-gray-800">{desc}</p>
          {badge && (
            <span
              className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${BADGE_STYLES[badge.color]}`}
            >
              {badge.label}
              {badge.tooltip && (
                <span
                  title={badge.tooltip}
                  className="cursor-help text-xs leading-none opacity-60 hover:opacity-100"
                >
                  ⓘ
                </span>
              )}
            </span>
          )}
        </div>
        {txn.notes && (
          <p className="text-xs text-gray-400 mt-0.5 truncate">{txn.notes}</p>
        )}
      </div>

      {/* Amount */}
      <div className={`text-sm font-semibold flex-shrink-0 tabular-nums ${
        isRevenue ? 'text-green-600' : 'text-red-600'
      }`}>
        {isRevenue ? '+' : '−'}{formatCurrency(txn.amount)}
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function OwnerPortalPage({ params, searchParams }: Props) {
  const { token } = await params
  const { month: monthParam, property: propertyParam } = await searchParams
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

  if (!portalToken) notFound()

  if (portalToken.revoked_at) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center max-w-sm w-full">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Access Revoked</h2>
          <p className="text-sm text-gray-500">
            This portal link has been revoked. Please contact your property manager for a new link.
          </p>
        </div>
      </div>
    )
  }

  if (portalToken.expires_at && new Date(portalToken.expires_at) < new Date()) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center max-w-sm w-full">
          <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Link Expired</h2>
          <p className="text-sm text-gray-500">
            This owner portal link has expired. Please contact your property manager for a new link.
          </p>
        </div>
      </div>
    )
  }

  // Record access
  await supabase
    .from('owner_portal_tokens')
    .update({ last_accessed_at: new Date().toISOString() })
    .eq('id', portalToken.id)

  const ownerRaw = Array.isArray(portalToken.property_owners)
    ? portalToken.property_owners[0]
    : portalToken.property_owners

  if (!ownerRaw) notFound()

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

  if (!property) notFound()

  // ── Multi-property portfolio setup ──────────────────────────────────────────
  const isMulti = !!portalToken.is_multi
    && Array.isArray(portalToken.property_ids)
    && portalToken.property_ids.length > 1

  let portfolioProperties: (typeof property)[] = [property]

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

  // Summary from filtered transactions
  const totalRevenue  = filteredTxns
    .filter((t) => (t.transaction_type as TxnType) === 'revenue')
    .reduce((s, t) => s + t.amount, 0)
  const totalExpenses = filteredTxns
    .filter((t) => (t.transaction_type as TxnType) === 'expense')
    .reduce((s, t) => s + t.amount, 0)
  const netIncome = totalRevenue - totalExpenses

  const txnsByProperty = new Map<string, typeof filteredTxns>()
  for (const t of filteredTxns) {
    const list = txnsByProperty.get(t.property_id) ?? []
    list.push(t)
    txnsByProperty.set(t.property_id, list)
  }

  function portalHref(overrides: { month?: string; property?: string }): string {
    const params = new URLSearchParams()
    params.set('month', overrides.month ?? selectedMonth)
    if (isMulti) params.set('property', overrides.property ?? selectedProperty)
    return `/owner/${token}?${params.toString()}`
  }

  const addressParts = viewProperty
    ? [viewProperty.address, viewProperty.city, viewProperty.state, viewProperty.zip].filter(Boolean)
    : []
  const addressDisplay = addressParts.length ? addressParts.join(', ') : null

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-5 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">
                FieldStay Owner Portal
              </p>
              {isMulti ? (
                <>
                  <h1 className="text-2xl font-bold text-gray-900">{ownerRaw.name}</h1>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {selectedProperty === 'all'
                      ? `Portfolio overview · ${portfolioProperties.length} properties`
                      : viewProperty?.name}
                  </p>
                  {selectedProperty !== 'all' && addressDisplay && (
                    <p className="text-sm text-gray-500 mt-0.5">{addressDisplay}</p>
                  )}
                </>
              ) : (
                <>
                  <h1 className="text-2xl font-bold text-gray-900">{viewProperty?.name}</h1>
                  {addressDisplay && (
                    <p className="text-sm text-gray-500 mt-0.5">{addressDisplay}</p>
                  )}
                </>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              {!isMulti && (
                <p className="text-sm font-medium text-gray-700">{ownerRaw.name}</p>
              )}
              {ownerRaw.revenue_share_pct != null && (
                <p className="text-xs text-gray-400 mt-0.5">{ownerRaw.revenue_share_pct}% revenue share</p>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-8 sm:px-6">

        {/* Property selector (multi-property portfolios only) */}
        {isMulti && (
          <div className="flex gap-2 overflow-x-auto pb-1 mb-3 -mx-1 px-1">
            <a
              href={portalHref({ property: 'all' })}
              className={[
                'px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors',
                selectedProperty === 'all'
                  ? 'bg-gray-900 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-400',
              ].join(' ')}
            >
              All Properties
            </a>
            {portfolioProperties.map((p) => (
              <a
                key={p.id}
                href={portalHref({ property: p.id })}
                className={[
                  'px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors',
                  selectedProperty === p.id
                    ? 'bg-gray-900 text-white'
                    : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-400',
                ].join(' ')}
              >
                {p.name}
              </a>
            ))}
          </div>
        )}

        {/* Month filter */}
        <div className="flex gap-2 overflow-x-auto pb-1 mb-6 -mx-1 px-1">
          {availableMonths.map((m) => (
            <a
              key={m}
              href={portalHref({ month: m })}
              className={[
                'px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors',
                m === selectedMonth
                  ? 'bg-gray-900 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-400',
              ].join(' ')}
            >
              {formatMonthLabel(m)}
            </a>
          ))}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Total Revenue</p>
            <p className="text-2xl font-bold text-green-600">{formatCurrency(totalRevenue)}</p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Total Expenses</p>
            <p className="text-2xl font-bold text-red-600">{formatCurrency(totalExpenses)}</p>
          </div>

          <div className={`rounded-xl border p-5 ${
            netIncome >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
          }`}>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Net Income</p>
            <p className={`text-2xl font-bold ${netIncome >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              {formatCurrency(netIncome)}
            </p>
          </div>
        </div>

        {/* Transaction list */}
        {filteredTxns.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <p className="text-gray-400 text-sm">No transactions for {formatMonthLabel(selectedMonth)}.</p>
          </div>
        ) : selectedProperty === 'all' ? (
          <div className="space-y-4">
            {portfolioProperties
              .filter((p) => (txnsByProperty.get(p.id)?.length ?? 0) > 0)
              .map((p) => (
                <div key={p.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
                    <h2 className="font-semibold text-gray-700 text-sm">
                      {p.name}
                      <span className="text-gray-400 font-normal"> · {formatMonthLabel(selectedMonth)}</span>
                    </h2>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {txnsByProperty.get(p.id)!.map((txn) => (
                      <TransactionRow key={txn.id} txn={txn} />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
              <h2 className="font-semibold text-gray-700 text-sm">{formatMonthLabel(selectedMonth)}</h2>
            </div>

            <div className="divide-y divide-gray-100">
              {filteredTxns.map((txn) => (
                <TransactionRow key={txn.id} txn={txn} />
              ))}
            </div>
          </div>
        )}

        <p className="text-center text-xs text-gray-400 mt-8">
          Powered by FieldStay · Data is read-only
        </p>
      </div>
    </div>
  )
}
