import { requireOrgMember } from '@/lib/auth'
import Link from 'next/link'
import { healthLabel, healthColor, healthDot, healthBgStyle } from '@/lib/assets/health-score'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Asset Health' }

export default async function AssetsPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: assets },
    { data: standards },
    { data: properties },
  ] = await Promise.all([
    supabase
      .from('property_assets')
      .select('id, property_id, name, asset_type, health_score, installation_date, make, model, health_score_updated_at')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('health_score', { ascending: true, nullsFirst: false }),

    supabase
      .from('asset_type_standards')
      .select('asset_type, display_name')
      .order('display_name'),

    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  const allAssets    = assets ?? []
  const allStandards = standards ?? []
  const allProperties = properties ?? []

  const propertyMap = Object.fromEntries(allProperties.map((p) => [p.id, p.name]))
  const typeLabel   = (t: string) =>
    allStandards.find((s) => s.asset_type === t)?.display_name ?? t.replace(/_/g, ' ')

  const scored    = allAssets.filter((a) => a.health_score != null)
  const unscored  = allAssets.filter((a) => a.health_score == null)

  const goodCount     = scored.filter((a) => a.health_score! >= 80).length
  const fairCount     = scored.filter((a) => { const s = a.health_score!; return s >= 60 && s < 80 }).length
  const agingCount    = scored.filter((a) => { const s = a.health_score!; return s >= 40 && s < 60 }).length
  const poorCount     = scored.filter((a) => { const s = a.health_score!; return s >= 20 && s < 40 }).length
  const criticalCount = scored.filter((a) => a.health_score! < 20).length

  const avgScore  = scored.length
    ? Math.round(scored.reduce((s, a) => s + a.health_score!, 0) / scored.length)
    : null

  const urgentAssets = allAssets.filter((a) => a.health_score != null && a.health_score < 40)

  return (
    <div className="max-w-4xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Asset Health</h1>
          <p className="page-subtitle">
            {allAssets.length} asset{allAssets.length !== 1 ? 's' : ''} tracked across {allProperties.length} propert{allProperties.length !== 1 ? 'ies' : 'y'}
          </p>
        </div>
      </div>

      {/* Portfolio summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <SummaryCard label="Total Assets"  value={allAssets.length} />
        <SummaryCard label="Avg Score"     value={avgScore != null ? `${avgScore}/100` : '—'} />
        <SummaryCard label="Needing Attention" value={urgentAssets.length}
          accent={urgentAssets.length > 0 ? 'var(--accent-red)' : undefined} />
        <SummaryCard label="Not Yet Scored" value={unscored.length} />
      </div>

      {/* Health breakdown pills */}
      {scored.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {goodCount     > 0 && <span className="badge" style={{ background: 'rgba(34,197,94,0.1)',  color: 'var(--accent-green)', border: '1px solid rgba(34,197,94,0.2)'  }}>🟢 {goodCount} Good</span>}
          {fairCount     > 0 && <span className="badge" style={{ background: 'rgba(250,189,0,0.1)',  color: 'var(--accent-gold)',  border: '1px solid rgba(250,189,0,0.2)'  }}>🟡 {fairCount} Fair</span>}
          {agingCount    > 0 && <span className="badge" style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>🟠 {agingCount} Aging</span>}
          {poorCount     > 0 && <span className="badge" style={{ background: 'rgba(240,84,84,0.1)',  color: 'var(--accent-red)',   border: '1px solid rgba(240,84,84,0.2)'  }}>🔴 {poorCount} Poor</span>}
          {criticalCount > 0 && <span className="badge" style={{ background: 'rgba(107,114,128,0.1)', color: '#6b7280', border: '1px solid rgba(107,114,128,0.2)' }}>⚫ {criticalCount} Critical</span>}
        </div>
      )}

      {/* Urgent assets alert */}
      {urgentAssets.length > 0 && (
        <div className="rounded-lg px-4 py-3 mb-6 text-sm"
             style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}>
          🚨 {urgentAssets.length} asset{urgentAssets.length > 1 ? 's' : ''} in Poor or Critical condition — budget for replacement.
        </div>
      )}

      {allAssets.length === 0 ? (
        <div className="card text-center py-16">
          <p className="text-muted-themed text-sm mb-4">No assets tracked yet.</p>
          <p className="text-muted-themed text-sm">
            Go to a{' '}
            <Link href="/properties" className="underline" style={{ color: 'var(--accent-blue)' }}>
              property page
            </Link>{' '}
            and add appliances, HVAC, roofing, and more.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-themed">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Asset</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Property</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide hidden sm:table-cell">Make / Model</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide hidden sm:table-cell">Age</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-themed">
                {allAssets.map((asset) => {
                  const ageYears = asset.installation_date
                    ? new Date().getFullYear() - new Date(asset.installation_date).getFullYear()
                    : null
                  const score  = asset.health_score
                  const color  = score != null ? healthColor(score) : '#6b7280'
                  const bg     = score != null ? healthBgStyle(score) : 'rgba(107,114,128,0.1)'
                  const dot    = score != null ? healthDot(score) : '⚪'
                  const label  = score != null ? healthLabel(score) : 'Unknown'

                  return (
                    <tr key={asset.id} className="hover:bg-raised-themed transition-colors">
                      <td className="px-4 py-3">
                        <Link
                          href={`/properties/${asset.property_id}`}
                          className="font-medium text-primary-themed hover:underline"
                        >
                          {asset.name}
                        </Link>
                        <p className="text-xs text-muted-themed mt-0.5">{typeLabel(asset.asset_type)}</p>
                      </td>
                      <td className="px-4 py-3 text-secondary-themed">
                        <Link href={`/properties/${asset.property_id}`} className="hover:underline">
                          {propertyMap[asset.property_id] ?? '—'}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-themed hidden sm:table-cell">
                        {[asset.make, asset.model].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-themed hidden sm:table-cell">
                        {ageYears != null ? `${ageYears}y` : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {score != null ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
                            style={{ color, background: bg, border: `1px solid ${color}44` }}
                          >
                            {dot} {score}/100 · {label}
                          </span>
                        ) : (
                          <span className="badge badge-slate">Unknown</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label:   string
  value:   string | number
  accent?: string
}) {
  return (
    <div className="card flex flex-col gap-1">
      <p className="text-xs text-muted-themed">{label}</p>
      <p
        className="text-2xl font-bold"
        style={{ color: accent ?? 'var(--text-primary)' }}
      >
        {value}
      </p>
    </div>
  )
}
