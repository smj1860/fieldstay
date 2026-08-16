import { requireOrgMember }          from '@/lib/auth'
import { unwrap, unwrapList }        from '@/lib/supabase/unwrap'
import { unwrapJoin }                from '@/lib/utils/supabase-joins'
import { SUPABASE_MAX_ROWS }         from '@/lib/inngest/paginate'
import Link                          from 'next/link'
import { TriggerLedgerButton }       from './trigger-ledger-button'
import { TriggerProjectionsButton }  from './trigger-projections-button'
import { StatusDropdown }            from './status-dropdown'
import { PropertyFilterSelect }      from './property-filter-select'
import { WhatIfPanel }               from './what-if-panel'
import { Card }                      from '@/components/ui/Card'
import { buttonVariantClass }        from '@/components/ui/Button'
import type { Metadata }             from 'next'
import type {
  CapExProjectionPayload,
  CapExProjectionItem,
} from '@/lib/inngest/functions/capex-projections'

interface RepairVsReplaceRow {
  asset_id:                  string
  property_id:               string
  repair_cost_trailing_12mo: number
  replacement_cost_estimate: number
  reasoning:                 string[]
  asset:                     { name: string } | { name: string }[] | null
  property:                  { name: string } | { name: string }[] | null
}

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

  const priorYear = currentYear - 1

  // Four independent reads in one wave. The replacement-status read used to
  // be a fifth here; it moved to a second wave below because it depends on
  // the capex milestone resolved in this one — see the note there.
  const [milestoneRes, deprMilestoneRes, propertiesRes, repairVsReplaceRes, orgSettingsRes] = await Promise.all([
    // CapEx projection
    supabase
      .from('org_milestones')
      .select('value, achieved_at')
      .eq('org_id', membership.org_id)
      .eq('milestone', `capex_projection_${currentYear}`)
      .maybeSingle(),

    // Depreciation ledger
    supabase
      .from('org_milestones')
      .select('value, achieved_at')
      .eq('org_id', membership.org_id)
      .eq('milestone', `depreciation_ledger_${priorYear}`)
      .maybeSingle(),

    // Properties for the filter
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name')
      .limit(SUPABASE_MAX_ROWS),

    // Repair-vs-Replace: assets the nightly asset-health cron currently
    // recommends replacing, independent of the age-based 10-year forecast
    // above — an asset with heavy recent repair spend can surface here long
    // before it would age into the projection.
    supabase
      .from('asset_capex_recommendations')
      .select('asset_id, property_id, repair_cost_trailing_12mo, replacement_cost_estimate, reasoning, asset:property_assets(name), property:properties(name)')
      .eq('org_id', membership.org_id)
      .eq('recommendation', 'replace')
      .order('computed_at', { ascending: false })
      .limit(SUPABASE_MAX_ROWS),

    // Default inflation rate for the What-If panel.
    supabase
      .from('organizations')
      .select('capex_inflation_rate_pct')
      .eq('id', membership.org_id)
      .single(),
  ])

  // Throws to app/(dashboard)/capital-planning/error.tsx on a failed read, so
  // an outage isn't rendered as "No projection data yet."
  const ctx = { site: 'page.capital-planning', orgId: membership.org_id }
  const milestone       = unwrap(milestoneRes,          { ...ctx, extra: { query: 'capex_milestone' } })
  const deprMilestone   = unwrap(deprMilestoneRes,      { ...ctx, extra: { query: 'depreciation_milestone' } })
  const properties      = unwrapList(propertiesRes,     { ...ctx, extra: { query: 'properties' } })
  const repairVsReplace = unwrapList<RepairVsReplaceRow>(
    repairVsReplaceRes,
    { ...ctx, extra: { query: 'repair_vs_replace' } },
  )
  const orgSettings = unwrap(orgSettingsRes, { ...ctx, extra: { query: 'org_settings' } })

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

  // ── Wave 2: replacement statuses, scoped to what is actually on screen ───
  //
  // This read had no bound at all — every non-`projected` asset in the org, on
  // a USER-FACING render, with the whole result set in memory before anything
  // paints. An earlier pass bounded it with `.limit(SUPABASE_MAX_ROWS)`, which
  // stopped the unbounded read but swapped one failure for a worse one:
  // SUPABASE_MAX_ROWS *is* PostgREST's own cap, so a portfolio org past it got
  // no error, it got SILENTLY WRONG STATUSES. Any asset beyond the cap misses
  // `statusByAsset` and renders as the default "Projected" no matter how it was
  // actually set. A capital plan quietly showing the wrong approval state is
  // worse than a slow one.
  //
  // Scoping to the ids being rendered fixes both: the result set is the size of
  // the PAGE rather than the size of the portfolio, and it cannot truncate,
  // because every chunk below is requested explicitly and sized under the cap.
  //
  // The cost is one extra round-trip wave — the ids come out of the capex
  // milestone, so this cannot join the Promise.all above. That is the trade the
  // earlier pass declined; it is worth making, because for a typical org this
  // query also gets strictly SMALLER (one row per projected item on screen, not
  // one per non-projected asset in the portfolio).
  //
  // Driven by filteredProjections, not the raw payload: with a property filter
  // applied, the statuses for other properties are not rendered and must not be
  // fetched.
  const renderedAssetIds = Array.from(new Set(
    Object.values(filteredProjections).flatMap((proj) => proj.items.map((i) => i.asset_id))
  ))

  // `.in()` puts every id in the query string, so the chunk size is set by URL
  // length, not by the row cap — same reasoning as cancelTurnoversForBookings.
  // Chunks are independent reads of one table, so they run concurrently.
  const STATUS_CHUNK = 200
  const statusChunkResults = await Promise.all(
    Array.from(
      { length: Math.ceil(renderedAssetIds.length / STATUS_CHUNK) },
      (_, c) => supabase
        .from('property_assets')
        .select('id, replacement_status')
        .eq('org_id', membership.org_id)
        .in('id', renderedAssetIds.slice(c * STATUS_CHUNK, (c + 1) * STATUS_CHUNK))
        .limit(STATUS_CHUNK),
    )
  )

  const statusByAsset = Object.fromEntries(
    statusChunkResults.flatMap((res, c) =>
      unwrapList(res, { ...ctx, extra: { query: 'property_assets', chunk: c } })
        .map((a) => [a.id, a.replacement_status as string])
    )
  )

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

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) ?? null

  const visibleRepairVsReplace = selectedPropertyId
    ? repairVsReplace.filter((r) => r.property_id === selectedPropertyId)
    : repairVsReplace

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
          <Link href="/assets" className={buttonVariantClass('ghost') + ' text-sm'}>← Assets</Link>
        </div>
      </div>

      {/* Property filter */}
      {properties.length > 1 && (
        <div className="mb-6">
          <PropertyFilterSelect
            properties={properties}
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
              <a href={`/api/assets/cpa-export?tax_year=${priorYear}`} className={buttonVariantClass('ghost') + ' text-sm'} download>
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

      {/* Repair-vs-Replace signals */}
      {visibleRepairVsReplace.length > 0 && (
        <Card
          className="mb-6 border-l-4"
          style={{ borderLeftColor: 'var(--accent-red)' }}
        >
          <div className="mb-3">
            <h3 className="font-semibold text-primary-themed">Repair vs. Replace Signals</h3>
            <p className="text-xs text-muted-themed mt-0.5">
              Flagged from recent repair spend and health score — independent of the age-based
              forecast below, so an asset can surface here before it ages into that projection.
            </p>
          </div>
          <div className="divide-y divide-themed">
            {visibleRepairVsReplace.map((item) => {
              const assetName    = unwrapJoin(item.asset)?.name ?? 'Asset'
              const propertyName = unwrapJoin(item.property)?.name ?? 'Property'
              return (
                <div key={item.asset_id} className="py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="font-medium text-primary-themed">{assetName}</span>
                      <span className="text-muted-themed text-xs ml-2">{propertyName}</span>
                    </div>
                    <span className="text-sm font-semibold flex-shrink-0" style={{ color: 'var(--accent-red)' }}>
                      ${Math.round(item.repair_cost_trailing_12mo).toLocaleString()} repaired
                      {' '}vs. ${Math.round(item.replacement_cost_estimate).toLocaleString()} new
                    </span>
                  </div>
                  {item.reasoning[0] && (
                    <p className="text-xs text-muted-themed mt-1">{item.reasoning[0]}</p>
                  )}
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

      {/* What-If: inflation + deferral scenario modeling */}
      {payload && Object.keys(filteredProjections).length > 0 && (
        <WhatIfPanel
          projections={filteredProjections}
          currentYear={currentYear}
          initialInflationRatePct={orgSettings?.capex_inflation_rate_pct ?? 4.0}
        />
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
                          {/* Tilde marks an age derived from the nameplate
                              manufacture year rather than a recorded install
                              date — see lib/assets/age-basis.ts. */}
                          <p title={item.age_estimated ? 'Age estimated from the nameplate manufacture year' : undefined}>
                            {item.age_estimated ? '~' : ''}{item.age_years}y · {item.pct_of_lifespan}% lifespan
                          </p>
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
            className={buttonVariantClass('ghost') + ' text-sm'}
          >
            Export CSV →
          </a>
        </div>
      )}
    </div>
  )
}
