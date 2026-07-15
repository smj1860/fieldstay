import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import type { TxnType } from '@/types/database'
import type { CapExProjectionItem } from '@/lib/inngest/functions/capex-projections'
import { loadOwnerPortalData, type OwnerPortalTxn } from './load-owner-portal-data'

export const metadata: Metadata = { title: 'Owner Portal — FieldStay' }

interface Props {
  params:       Promise<{ token: string }>
  searchParams: Promise<{ month?: string; property?: string }>
}

// ── Display helpers ───────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              'USD',
    minimumFractionDigits: 2,
  }).format(amount)
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

function TransactionRow({ txn }: Readonly<{ txn: OwnerPortalTxn }>) {
  const isRevenue = (txn.transaction_type as TxnType) === 'revenue'
  const badge     = SOURCE_BADGES[txn.source ?? ''] ?? null
  const desc      = txn.description || SOURCE_FALLBACK_LABELS[txn.source ?? ''] || txn.category

  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      {/* Date */}
      <div className="w-16 flex-shrink-0 text-xs text-muted-themed tabular-nums">
        {formatDate(txn.transaction_date)}
      </div>

      {/* Description + source badge */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-primary-themed">{desc}</p>
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
          <p className="text-xs text-muted-themed mt-0.5 truncate">{txn.notes}</p>
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

  const pageState = await loadOwnerPortalData(token, monthParam, propertyParam)

  if (!pageState) notFound()

  if (pageState.status === 'revoked') {
    return (
      <div className="min-h-screen bg-canvas-themed flex items-center justify-center p-4">
        <div className="bg-card-themed rounded-2xl shadow-sm border border-themed p-8 text-center max-w-sm w-full">
          <h2 className="text-lg font-semibold text-primary-themed mb-2">Access Revoked</h2>
          <p className="text-sm text-muted-themed">
            This portal link has been revoked. Please contact your property manager for a new link.
          </p>
        </div>
      </div>
    )
  }

  if (pageState.status === 'expired') {
    return (
      <div className="min-h-screen bg-canvas-themed flex items-center justify-center p-4">
        <div className="bg-card-themed rounded-2xl shadow-sm border border-themed p-8 text-center max-w-sm w-full">
          <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-primary-themed mb-2">Link Expired</h2>
          <p className="text-sm text-muted-themed">
            This owner portal link has expired. Please contact your property manager for a new link.
          </p>
        </div>
      </div>
    )
  }

  const {
    ownerName, revenueSharePct, isMulti, portfolioProperties, selectedProperty, viewProperty,
    addressDisplay, availableMonths, selectedMonth, filteredTxns, txnsByProperty,
    totalRevenue, totalExpenses, netIncome, occupancy, lastYearMonthLabel, capexPayload,
  } = pageState.data

  function portalHref(overrides: { month?: string; property?: string }): string {
    const params = new URLSearchParams()
    params.set('month', overrides.month ?? selectedMonth)
    if (isMulti) params.set('property', overrides.property ?? selectedProperty)
    return `/owner/${token}?${params.toString()}`
  }

  return (
    <div className="min-h-screen bg-canvas-themed">
      {/* Header */}
      <header className="bg-card-themed border-b border-themed">
        <div className="max-w-4xl mx-auto px-4 py-5 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-muted-themed uppercase tracking-widest mb-1">
                FieldStay Owner Portal
              </p>
              {isMulti ? (
                <>
                  <h1 className="text-2xl font-bold text-primary-themed">{ownerName}</h1>
                  <p className="text-sm text-muted-themed mt-0.5">
                    {selectedProperty === 'all'
                      ? `Portfolio overview · ${portfolioProperties.length} properties`
                      : viewProperty?.name}
                  </p>
                  {selectedProperty !== 'all' && addressDisplay && (
                    <p className="text-sm text-muted-themed mt-0.5">{addressDisplay}</p>
                  )}
                </>
              ) : (
                <>
                  <h1 className="text-2xl font-bold text-primary-themed">{viewProperty?.name}</h1>
                  {addressDisplay && (
                    <p className="text-sm text-muted-themed mt-0.5">{addressDisplay}</p>
                  )}
                </>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              {!isMulti && (
                <p className="text-sm font-medium text-secondary-themed">{ownerName}</p>
              )}
              {revenueSharePct !== null && (
                <p className="text-xs text-muted-themed mt-0.5">{revenueSharePct}% revenue share</p>
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
                  : 'bg-card-themed border border-themed text-secondary-themed hover:border-gray-400',
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
                    : 'bg-card-themed border border-themed text-secondary-themed hover:border-gray-400',
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
                  : 'bg-card-themed border border-themed text-secondary-themed hover:border-gray-400',
              ].join(' ')}
            >
              {formatMonthLabel(m)}
            </a>
          ))}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-card-themed rounded-xl border border-themed p-5">
            <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-1">Total Revenue</p>
            <p className="text-2xl font-bold text-green-600">{formatCurrency(totalRevenue)}</p>
          </div>

          <div className="bg-card-themed rounded-xl border border-themed p-5">
            <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-1">Total Expenses</p>
            <p className="text-2xl font-bold text-red-600">{formatCurrency(totalExpenses)}</p>
          </div>

          <div className={`rounded-xl border p-5 ${
            netIncome >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
          }`}>
            <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-1">Net Income</p>
            <p className={`text-2xl font-bold ${netIncome >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              {formatCurrency(netIncome)}
            </p>
          </div>
        </div>

        {/* Occupancy */}
        <div className="bg-card-themed rounded-xl border border-themed p-5 mb-8">
          <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-3">Occupancy</h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <p className="text-2xl font-bold text-primary-themed">{occupancy.currentMonth.rate}%</p>
              <p className="text-xs mt-0.5 text-muted-themed">{formatMonthLabel(selectedMonth)}</p>
              <p className="text-xs text-muted-themed">
                {occupancy.currentMonth.bookedNights} of {occupancy.currentMonth.totalNights} nights
              </p>
            </div>
            {occupancy.sameMonthLastYear && (
              <div className="text-center">
                <p className="text-2xl font-bold text-muted-themed">{occupancy.sameMonthLastYear.rate}%</p>
                <p className="text-xs mt-0.5 text-muted-themed">{lastYearMonthLabel}</p>
                <p className="text-xs text-muted-themed">Same month last year</p>
              </div>
            )}
            <div className="text-center">
              <p className="text-2xl font-bold text-muted-themed">{occupancy.rolling12Month.rate}%</p>
              <p className="text-xs mt-0.5 text-muted-themed">12-month avg</p>
            </div>
          </div>

          {occupancy.sameMonthLastYear && (() => {
            const diff = occupancy.currentMonth.rate - occupancy.sameMonthLastYear.rate
            if (diff === 0) return null
            return (
              <p className={`text-xs text-center mt-3 font-medium ${diff > 0 ? 'text-green-600' : 'text-red-600'}`}>
                {diff > 0 ? '↑' : '↓'} {Math.abs(diff)}pp vs same month last year
              </p>
            )
          })()}
        </div>

        {/* Capital plan — only shown when PM has opted in */}
        {capexPayload && Object.keys(capexPayload.projections).length > 0 && (() => {
          const currentYear   = new Date().getFullYear()
          const horizonYears  = Array.from({ length: 10 }, (_, i) => currentYear + i)
          const allItems      = horizonYears.flatMap(
            (y) => capexPayload!.projections[y]?.items ?? []
          )
          const totalLow  = allItems.reduce((s, i) => s + i.cost_low, 0)
          const totalHigh = allItems.reduce((s, i) => s + i.cost_high, 0)

          return (
            <div className="bg-card-themed rounded-xl border border-themed p-5 mb-8">
              <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-1">
                Capital Planning
              </h3>
              <p className="text-xs text-muted-themed mb-4">
                Projected asset replacements over the next 10 years based on
                age, lifespan, and condition scoring.
              </p>

              {/* Summary */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="bg-raised-themed rounded-lg p-3">
                  <p className="text-xs text-muted-themed mb-0.5">10-Year Projected Cost</p>
                  <p className="text-lg font-bold text-primary-themed">
                    ${totalLow.toLocaleString()}–${totalHigh.toLocaleString()}
                  </p>
                </div>
                <div className="bg-raised-themed rounded-lg p-3">
                  <p className="text-xs text-muted-themed mb-0.5">Monthly Reserve Target</p>
                  <p className="text-lg font-bold text-primary-themed">
                    ${Math.round(totalLow / 120).toLocaleString()}–${Math.round(totalHigh / 120).toLocaleString()}/mo
                  </p>
                </div>
              </div>

              {/* Year-by-year items */}
              <div className="space-y-3">
                {horizonYears.map((year) => {
                  const proj = capexPayload!.projections[year]
                  if (!proj?.items?.length) return null
                  return (
                    <div key={year}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm font-semibold text-secondary-themed">{year}</span>
                        <span className="text-xs font-medium text-muted-themed">
                          ${proj.total_low.toLocaleString()}–${proj.total_high.toLocaleString()}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {proj.items.map((item: CapExProjectionItem) => (
                          <div
                            key={item.asset_id}
                            className="flex items-center justify-between text-sm px-3 py-2 bg-raised-themed rounded-lg"
                          >
                            <div className="min-w-0">
                              <span className="font-medium text-primary-themed">{item.asset_name}</span>
                              <span className="text-muted-themed text-xs ml-2">
                                {item.asset_type.replace(/_/g, ' ')}
                              </span>
                            </div>
                            <div className="text-right flex-shrink-0 ml-4">
                              <span className="text-xs text-muted-themed">
                                ${item.cost_low.toLocaleString()}
                                {item.cost_high !== item.cost_low
                                  ? `–$${item.cost_high.toLocaleString()}`
                                  : ''}
                              </span>
                              {item.health_score !== null && (
                                <span className={`ml-2 text-xs font-medium ${
                                  item.health_score >= 80 ? 'text-green-600'
                                  : item.health_score >= 60 ? 'text-amber-600'
                                  : 'text-red-600'
                                }`}>
                                  {item.health_score}/100
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className="text-xs text-muted-themed mt-4">
                Projections are estimates based on asset age and expected lifespan.
                Actual replacement timing and costs may vary.
              </p>
            </div>
          )
        })()}

        {/* Transaction list */}
        {filteredTxns.length === 0 ? (
          <div className="bg-card-themed rounded-xl border border-themed p-10 text-center">
            <p className="text-muted-themed text-sm">No transactions for {formatMonthLabel(selectedMonth)}.</p>
          </div>
        ) : selectedProperty === 'all' ? (
          <div className="space-y-4">
            {portfolioProperties
              .filter((p) => (txnsByProperty.get(p.id)?.length ?? 0) > 0)
              .map((p) => (
                <div key={p.id} className="bg-card-themed rounded-xl border border-themed overflow-hidden">
                  <div className="px-5 py-3 bg-raised-themed border-b border-themed">
                    <h2 className="font-semibold text-secondary-themed text-sm">
                      {p.name}
                      <span className="text-muted-themed font-normal"> · {formatMonthLabel(selectedMonth)}</span>
                    </h2>
                  </div>
                  <div className="divide-y divide-themed">
                    {txnsByProperty.get(p.id)!.map((txn) => (
                      <TransactionRow key={txn.id} txn={txn} />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div className="bg-card-themed rounded-xl border border-themed overflow-hidden">
            <div className="px-5 py-3 bg-raised-themed border-b border-themed">
              <h2 className="font-semibold text-secondary-themed text-sm">{formatMonthLabel(selectedMonth)}</h2>
            </div>

            <div className="divide-y divide-themed">
              {filteredTxns.map((txn) => (
                <TransactionRow key={txn.id} txn={txn} />
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col items-center gap-2 mt-8">
          <p className="text-center text-xs text-muted-themed">
            Powered by FieldStay · Data is read-only
          </p>
          <div className="flex items-center gap-3">
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-themed hover:text-secondary-themed transition-colors underline underline-offset-2"
            >
              Privacy Policy
            </a>
            <span className="text-muted-themed">·</span>
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-themed hover:text-secondary-themed transition-colors underline underline-offset-2"
            >
              Terms of Service
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
