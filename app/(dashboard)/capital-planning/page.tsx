import { requireOrgMember }          from '@/lib/auth'
import Link                          from 'next/link'
import { TriggerLedgerButton }       from './trigger-ledger-button'
import { TriggerProjectionsButton }  from './trigger-projections-button'
import { StatusDropdown }            from './status-dropdown'
import { PropertyFilterSelect }      from './property-filter-select'
import { Card }                      from '@/components/ui/Card'
import type { Metadata }             from 'next'
import type {
  CapExProjectionPayload,
  CapExProjectionItem,
} from '@/lib/inngest/functions/capex-projections'

export const metadata: Metadata = { title: 'Capital Planning' }

const HORIZON_YEARS = 10

const STATUS_LABELS: Record<string, string> = {
  projected: 'Projected',
  budgeted:  'Budgeted',
  approved:  'Approved',
  deferred:  'Deferred',
}

const STATUS_COLORS: Record<string, string> = {
  projected: 'var(--text-muted)',
  budgeted:  'var(--accent-gold)',
  approved:  'var(--accent-green)',
  deferred:  'var(--text-muted)',
}

export default async function CapitalPlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ property?: string }>
}) {
  const { supabase, membership } = await requireOrgMember()
  const currentYear = new Date().getFullYear()
  const { property: selectedPropertyId } = await searchParams

  // Load CapEx projection
  const { data: milestone } = await supabase
    .from('org_milestones')
    .select('value, achieved_at')
    .eq('org_id', membership.org_id)
    .eq('milestone', `capex_projection_${currentYear}`)
    .maybeSingle()

  // Load depreciation ledger
  const priorYear = currentYear - 1
  const { data: deprMilestone } = await supabase
    .from('org_milestones')
    .select('value, achieved_at')
    .eq('org_id', membership.org_id)
    .eq('milestone', `depreciation_ledger_${priorYear}`)
    .maybeSingle()

  // Load properties for filter
  const { data: properties } = await supabase
    .from('properties')
    .select('id, name')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  // Load replacement statuses for all assets — used to enrich projection items
  const { data: assetStatuses } = await supabase
    .from('property_assets')
    .select('id, replacement_status')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .neq('replacement_status', 'projected')  // only load non-default statuses

  const statusByAsset = Object.fromEntries(
    (assetStatuses ?? []).map((a) => [a.id, a.replacement_status as string])
  )

  const payload     = milestone?.value as CapExProjectionPayload | null
  const projections = payload?.projections ?? {}

  // Filter items by selected property if one is chosen
  const filteredProjections: Record<number, { total_low: number; total_high: number; items: CapExProjectionItem[] }> = {}
  for (const [yearStr, proj] of Object.entries(projections)) {
    const year  = Number(yearStr)
    const items = selectedPropertyId
      ? proj.items.filter((i) => i.property_id === selectedPropertyId)
      : proj.items
    if (items.length === 0) continue
    filteredProjections[year] = {
      total_low:  items.reduce((s, i) => s + i.cost_low, 0),
      total_high: items.reduce((s, i) => s + i.cost_high, 0),
      items,
    }
  }

  const years      = Array.from({ length: HORIZON_YEARS }, (_, i) => currentYear + i)
  const maxHigh    = Math.max(...years.map((y) => filteredProjections[y]?.total_high ?? 0), 1)
  const deprValue  = deprMilestone?.value as { total_depr?: number; entry_count?: number } | null

  // 12-month urgency: items due this year or next
  const urgentYears  = [currentYear, currentYear + 1]
  const urgentItems  = urgentYears.flatMap((y) => filteredProjections[y]?.items ?? [])
  const urgentLow    = urgentItems.reduce((s, i) => s + i.cost_low, 0)
  const urgentHigh   = urgentItems.reduce((s, i) => s + i.cost_high, 0)

  // Reserve fund calculator — monthly reserve = total 10-year cost / 120 months
  const totalLow10  = years.reduce((s, y) => s + (filteredProjections[y]?.total_low  ?? 0), 0)
  const totalHigh10 = years.reduce((s, y) => s + (filteredProjections[y]?.total_high ?? 0), 0)
  const monthlyLow  = Math.round(totalLow10  / 120)
  const monthlyHigh = Math.round(totalHigh10 / 120)

  const selectedProperty = properties?.find((p) => p.id === selectedPropertyId) ?? null

  return (
    <div className="max-w-4xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Capital Planning</h1>
          <p className="page-subtitle">
            {selectedProperty
              ? `${selectedProperty.name} — replacement forecast`
              : '10-year replacement cost forecast based on asset age & lifespan'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/assets" className="btn-ghost text-sm">← Asset Health</Link>
        </div>
      </div>

      {/* Property filter */}
      {(properties?.length ?? 0) > 1 && (
        <div className="mb-6">
          <PropertyFilterSelect
            properties={properties ?? []}
            selectedPropertyId={selectedPropertyId}
          />
        </div>
      )}

      {/* Depreciation ledger card */}
      <Card className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-primary-themed">Depreciation Ledger</h3>
            <p className="text-xs text-muted-themed mt-0.5">
              {deprValue
                ? `${priorYear} ledger — ${deprValue.entry_count} assets · $${(deprValue.total_depr ?? 0).toLocaleString()} total depreciation`
                : `No ${priorYear} ledger generated yet`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {deprValue && (
              <a href={`/api/assets/cpa-export?tax_year=${priorYear}`} className="btn-ghost text-sm" download>
                Export PDF →
              </a>
            )}
            <TriggerLedgerButton taxYear={priorYear} orgId={membership.org_id} />
          </div>
        </div>
      </Card>

      <p className="text-xs text-muted-themed mb-6 px-1">
        Depreciation entries use MACRS as defined by the IRS. Only assets with
        both a purchase price and a placed-in-service date are included.
        Consult your CPA before filing.
      </p>

      {/* 12-month urgency card */}
      {urgentItems.length > 0 && (
        <Card
          className="mb-6 border-l-4"
          style={{ borderLeftColor: 'var(--accent-amber)' }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-primary-themed">
              Upcoming in 12–24 Months
            </h3>
            <span className="text-sm font-semibold" style={{ color: 'var(--accent-amber)' }}>
              ${urgentLow.toLocaleString()}–${urgentHigh.toLocaleString()}
            </span>
          </div>
          <div className="space-y-2">
            {urgentItems.map((item) => {
              const status = statusByAsset[item.asset_id] ?? 'projected'
              return (
                <div key={item.asset_id} className="flex items-center gap-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-primary-themed">{item.asset_name}</span>
                    <span className="text-muted-themed text-xs ml-2">
                      {item.property_name} · {item.replacement_year}
                    </span>
                  </div>
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full"
                    style={{
                      color:      STATUS_COLORS[status] ?? 'var(--text-muted)',
                      background: 'var(--bg-raised)',
                    }}
                  >
                    {STATUS_LABELS[status] ?? status}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Reserve fund calculator */}
      {payload && totalHigh10 > 0 && (
        <Card className="mb-6">
          <h3 className="font-semibold text-primary-themed mb-3">Reserve Fund Recommendation</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-themed mb-1">10-Year Projected Cost</p>
              <p className="text-lg font-bold text-primary-themed">
                ${totalLow10.toLocaleString()}–${totalHigh10.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-themed mb-1">Recommended Monthly Reserve</p>
              <p className="text-lg font-bold" style={{ color: 'var(--accent-gold)' }}>
                ${monthlyLow.toLocaleString()}–${monthlyHigh.toLocaleString()}/mo
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-themed mt-3">
            Based on straight-line amortisation over 10 years
            {selectedProperty ? ` for ${selectedProperty.name}` : ' across all properties'}.
          </p>
        </Card>
      )}

      {/* 10-year bar chart */}
      <Card className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-primary-themed">10-Year Replacement Forecast</h3>
          <TriggerProjectionsButton orgId={membership.org_id} currentYear={currentYear} />
        </div>

        {payload ? (
          <>
            <div className="flex items-end gap-2 h-40 mb-2">
              {years.map((year) => {
                const proj      = filteredProjections[year]
                const high      = proj?.total_high ?? 0
                const heightPct = (high / maxHigh) * 100
                const barColor  = high === 0 ? 'var(--bg-raised)'
                  : high > 15000 ? 'var(--accent-red)'
                  : high > 5000  ? 'var(--accent-amber)'
                  : 'var(--accent-green)'
                return (
                  <div key={year} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full flex flex-col justify-end" style={{ height: '120px' }}>
                      {high > 0 && (
                        <div
                          className="w-full rounded-t-sm transition-all"
                          style={{
                            height:     `${Math.max(heightPct, 4)}%`,
                            background: barColor,
                            minHeight:  '4px',
                          }}
                          title={`$${Math.round(proj?.total_low ?? 0).toLocaleString()} – $${Math.round(high).toLocaleString()}`}
                        />
                      )}
                    </div>
                    <span className="text-xs text-muted-themed">{year}</span>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-themed mt-2 pt-3 border-t border-themed">
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm inline-block" style={{ background: 'var(--accent-green)' }} /> &lt; $5k
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm inline-block" style={{ background: 'var(--accent-amber)' }} /> $5k–$15k
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm inline-block" style={{ background: 'var(--accent-red)' }} /> &gt; $15k
              </span>
            </div>
          </>
        ) : (
          <div className="text-center py-10 text-muted-themed text-sm">
            <p>No projection data yet.</p>
            <p className="mt-1">Click Generate Projections — assets with installation dates will populate the forecast immediately.</p>
          </div>
        )}
      </Card>

      {/* Itemized list by year */}
      {payload && years.some((y) => (filteredProjections[y]?.items?.length ?? 0) > 0) && (
        <div className="space-y-4">
          {years.map((year) => {
            const proj = filteredProjections[year]
            if (!proj?.items?.length) return null
            return (
              <Card key={year}>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-semibold text-primary-themed">{year}</h4>
                  <span className="text-sm font-semibold" style={{ color: 'var(--accent-gold)' }}>
                    ${Math.round(proj.total_low).toLocaleString()} – ${Math.round(proj.total_high).toLocaleString()}
                  </span>
                </div>
                <div className="divide-y divide-themed">
                  {proj.items.map((item: CapExProjectionItem) => {
                    const status = statusByAsset[item.asset_id] ?? 'projected'
                    return (
                      <div key={item.asset_id} className="py-2.5 flex items-center gap-4 text-sm">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-primary-themed truncate">{item.asset_name}</p>
                          <p className="text-xs text-muted-themed mt-0.5">
                            {!selectedPropertyId && `${item.property_name} · `}
                            {item.asset_type.replace(/_/g, ' ')}
                          </p>
                        </div>
                        <div className="text-xs text-muted-themed text-right flex-shrink-0">
                          <p>{item.age_years}y · {item.pct_of_lifespan}% lifespan</p>
                          {item.health_score !== null && (
                            <p className="mt-0.5">Score: {item.health_score}/100</p>
                          )}
                        </div>
                        <div className="text-sm font-medium text-right flex-shrink-0" style={{ color: 'var(--accent-gold)' }}>
                          ${item.cost_low.toLocaleString()}
                          {item.cost_high !== item.cost_low && ` – $${item.cost_high.toLocaleString()}`}
                        </div>
                        <StatusDropdown
                          assetId={item.asset_id}
                          currentStatus={status as 'projected' | 'budgeted' | 'approved' | 'deferred'}
                        />
                      </div>
                    )
                  })}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {payload && (
        <div className="mt-4 flex justify-end">
          <a
            href={`/api/assets/capex-csv?year=${currentYear}`}
            download={`capex-forecast-${currentYear}.csv`}
            className="btn-ghost text-sm"
          >
            Export CSV →
          </a>
        </div>
      )}
    </div>
  )
}
