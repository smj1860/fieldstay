import { requireOrgMember } from '@/lib/auth'
import Link from 'next/link'
import { TriggerLedgerButton } from './trigger-ledger-button'
import type { Metadata } from 'next'
import type { CapExProjectionPayload, CapExProjectionItem } from '@/lib/inngest/functions/capex-projections'

export const metadata: Metadata = { title: 'Capital Planning' }

const HORIZON_YEARS = 10

export default async function CapitalPlanningPage() {
  const { supabase, membership } = await requireOrgMember()
  const currentYear = new Date().getFullYear()

  // Load latest CapEx projection from org_milestones
  const { data: milestone } = await supabase
    .from('org_milestones')
    .select('value, achieved_at')
    .eq('org_id', membership.org_id)
    .eq('milestone', `capex_projection_${currentYear}`)
    .maybeSingle()

  // Load depreciation ledger milestone
  const priorYear = currentYear - 1
  const { data: deprMilestone } = await supabase
    .from('org_milestones')
    .select('value, achieved_at')
    .eq('org_id', membership.org_id)
    .eq('milestone', `depreciation_ledger_${priorYear}`)
    .maybeSingle()

  const payload = milestone?.value as CapExProjectionPayload | null
  const projections = payload?.projections ?? {}

  // Build year range
  const years = Array.from({ length: HORIZON_YEARS }, (_, i) => currentYear + i)
  const maxHigh = Math.max(...years.map((y) => projections[y]?.total_high ?? 0), 1)

  // Depreciation summary
  const deprValue = deprMilestone?.value as { total_depr?: number; entry_count?: number } | null

  return (
    <div className="max-w-4xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Capital Planning</h1>
          <p className="page-subtitle">10-year replacement cost forecast based on asset age &amp; lifespan</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/assets"
            className="btn-ghost text-sm"
          >
            ← Asset Health
          </Link>
        </div>
      </div>

      {/* Depreciation ledger card */}
      <div className="card mb-6">
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
              <a
                href={`/api/assets/cpa-export?tax_year=${priorYear}`}
                className="btn-ghost text-sm"
                download
              >
                Export PDF →
              </a>
            )}
            <TriggerLedgerButton taxYear={priorYear} orgId={membership.org_id} />
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-themed mb-6 px-1">
        Depreciation entries use the Modified Accelerated Cost Recovery System
        (MACRS) as defined by the IRS. Only assets with both a purchase price and
        a placed-in-service date are included — assets missing either are
        silently excluded from the ledger. This tool estimates depreciation for
        planning purposes; consult your CPA before filing.
      </p>

      {/* Bar chart */}
      <div className="card mb-6">
        <h3 className="font-semibold text-primary-themed mb-4">10-Year Replacement Forecast</h3>

        {payload ? (
          <>
            <div className="flex items-end gap-2 h-40 mb-2">
              {years.map((year) => {
                const proj     = projections[year]
                const high     = proj?.total_high ?? 0
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
                            height: `${Math.max(heightPct, 4)}%`,
                            background: barColor,
                            minHeight: '4px',
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
            <p className="mt-1">Projections generate automatically on the 1st of each month once assets have installation dates.</p>
          </div>
        )}
      </div>

      {/* Itemized list by year */}
      {payload && years.some((y) => (projections[y]?.items?.length ?? 0) > 0) && (
        <div className="space-y-4">
          {years.map((year) => {
            const proj = projections[year]
            if (!proj?.items?.length) return null

            return (
              <div key={year} className="card">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-semibold text-primary-themed">{year}</h4>
                  <span className="text-sm font-semibold" style={{ color: 'var(--accent-gold)' }}>
                    ${Math.round(proj.total_low).toLocaleString()} – ${Math.round(proj.total_high).toLocaleString()}
                  </span>
                </div>
                <div className="divide-y divide-themed">
                  {proj.items.map((item: CapExProjectionItem) => (
                    <div key={item.asset_id} className="py-2.5 flex items-center gap-4 text-sm">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-primary-themed truncate">{item.asset_name}</p>
                        <p className="text-xs text-muted-themed mt-0.5">
                          {item.property_name} · {item.asset_type.replace(/_/g, ' ')}
                        </p>
                      </div>
                      <div className="text-xs text-muted-themed text-right flex-shrink-0">
                        <p>{item.age_years}y · {item.pct_of_lifespan}% lifespan</p>
                        {item.health_score != null && (
                          <p className="mt-0.5">Score: {item.health_score}/100</p>
                        )}
                      </div>
                      <div className="text-sm font-medium text-right flex-shrink-0" style={{ color: 'var(--accent-gold)' }}>
                        ${item.cost_low.toLocaleString()}
                        {item.cost_high !== item.cost_low && ` – $${item.cost_high.toLocaleString()}`}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* CSV export */}
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
