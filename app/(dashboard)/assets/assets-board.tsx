'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { healthLabel, healthColor, healthBgStyle, healthDot } from '@/lib/assets/health-score'
import { REQUIRED_ASSET_TYPES, assetTypeDisplayName } from '@/lib/asset-discovery/config'
import { createClient } from '@/lib/supabase/client'
import { StatusDot } from '@/components/ui/StatusDot'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import type { AssetType } from '@/types/database'

export interface AssetRow {
  id:                      string
  property_id:             string
  name:                    string
  asset_type:              string
  health_score:            number | null
  installation_date:       string | null
  make:                    string | null
  model:                   string | null
  health_score_updated_at: string | null
  is_na:                   boolean
}

export interface PropertyOption {
  id:   string
  name: string
}

export interface StandardOption {
  asset_type:   string
  display_name: string
}

function isDiscovered(asset: Pick<AssetRow, 'make' | 'model' | 'is_na'> & { photo_url?: string | null }): boolean {
  return asset.is_na === true || asset.make !== null || asset.model !== null || (asset as { photo_url?: string | null }).photo_url !== null
}

function missingTypesForProperty(propertyId: string, assets: AssetRow[]): AssetType[] {
  const discoveredTypes = new Set(
    assets
      .filter((a) => a.property_id === propertyId && REQUIRED_ASSET_TYPES.includes(a.asset_type as AssetType))
      .filter((a) => isDiscovered(a))
      .map((a) => a.asset_type as AssetType)
  )
  return REQUIRED_ASSET_TYPES.filter((t) => !discoveredTypes.has(t))
}

export function AssetsBoard({
  orgId,
  assets,
  properties,
  standards,
}: Readonly<{
  orgId:      string
  assets:     AssetRow[]
  properties: PropertyOption[]
  standards:  StandardOption[]
}>) {
  const router = useRouter()
  const [filterProperty, setFilterProperty] = useState('all')

  // Live-refresh the dashboard when a turnover finishes and writes new
  // property_assets rows, without a hard page reload.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`asset-health-${orgId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'property_assets',
        filter: `org_id=eq.${orgId}`,
      }, () => router.refresh())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [orgId, router])

  const propertyMap = useMemo(
    () => Object.fromEntries(properties.map((p) => [p.id, p.name])),
    [properties]
  )
  const typeLabel = (t: string) =>
    standards.find((s) => s.asset_type === t)?.display_name ?? assetTypeDisplayName(t as AssetType)

  const filteredAssets = filterProperty === 'all'
    ? assets
    : assets.filter((a) => a.property_id === filterProperty)

  // N/A assets are excluded from totals, averages, and attention counts —
  // they were explicitly marked as not present at the property.
  const realAssets = filteredAssets.filter((a) => !a.is_na)
  const scored      = realAssets.filter((a) => a.health_score !== null)
  const urgentAssets = realAssets.filter((a) => a.health_score !== null && a.health_score < 40)

  const avgScore = scored.length
    ? Math.round(scored.reduce((s, a) => s + a.health_score!, 0) / scored.length)
    : null

  const goodCount     = scored.filter((a) => a.health_score! >= 80).length
  const fairCount     = scored.filter((a) => { const s = a.health_score!; return s >= 60 && s < 80 }).length
  const agingCount    = scored.filter((a) => { const s = a.health_score!; return s >= 40 && s < 60 }).length
  const poorCount     = scored.filter((a) => { const s = a.health_score!; return s >= 20 && s < 40 }).length
  const criticalCount = scored.filter((a) => a.health_score! < 20).length

  // Pending Discovery — system-mandated master list assets not yet captured.
  // Scoped to the selected property, or summed across the whole portfolio.
  const pendingDiscoveryCount = filterProperty === 'all'
    ? properties.reduce((sum, p) => sum + missingTypesForProperty(p.id, assets).length, 0)
    : missingTypesForProperty(filterProperty, assets).length

  const placeholderTypes = filterProperty === 'all'
    ? []
    : missingTypesForProperty(filterProperty, assets)

  const selectedPropertyName = filterProperty !== 'all' ? propertyMap[filterProperty] ?? '—' : null

  return (
    <div className="max-w-4xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Asset Health</h1>
          <p className="page-subtitle">
            {realAssets.length} asset{realAssets.length !== 1 ? 's' : ''} tracked across {properties.length} propert{properties.length !== 1 ? 'ies' : 'y'}
          </p>
        </div>
      </div>

      {properties.length > 1 && (
        <div className="mb-4">
          <select
            value={filterProperty}
            onChange={(e) => setFilterProperty(e.target.value)}
            className="input text-sm py-1.5 w-auto"
          >
            <option value="all">All Properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Portfolio summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <SummaryCard label="Total Assets"  value={realAssets.length} />
        <SummaryCard label="Avg Score"     value={avgScore !== null ? `${avgScore}/100` : '—'} />
        <SummaryCard label="Needing Attention" value={urgentAssets.length}
          accent={urgentAssets.length > 0 ? 'var(--accent-red)' : undefined} />
        <SummaryCard label="Pending Discovery" value={pendingDiscoveryCount}
          accent={pendingDiscoveryCount > 0 ? 'var(--accent-gold)' : undefined} />
      </div>

      {/* Health breakdown pills */}
      {scored.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {goodCount     > 0 && <span className="badge flex items-center gap-1.5" style={{ background: 'rgba(34,197,94,0.1)',  color: 'var(--accent-green)', border: '1px solid rgba(34,197,94,0.2)'  }}><StatusDot status="good" label="Good" /> {goodCount} Good</span>}
          {fairCount     > 0 && <span className="badge flex items-center gap-1.5" style={{ background: 'rgba(250,189,0,0.1)',  color: 'var(--accent-gold)',  border: '1px solid rgba(250,189,0,0.2)'  }}><StatusDot status="warning" label="Fair" /> {fairCount} Fair</span>}
          {agingCount    > 0 && <span className="badge flex items-center gap-1.5" style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}><StatusDot status="attention" label="Aging" /> {agingCount} Aging</span>}
          {poorCount     > 0 && <span className="badge flex items-center gap-1.5" style={{ background: 'rgba(240,84,84,0.1)',  color: 'var(--accent-red)',   border: '1px solid rgba(240,84,84,0.2)'  }}><StatusDot status="critical" label="Poor" /> {poorCount} Poor</span>}
          {criticalCount > 0 && <span className="badge flex items-center gap-1.5" style={{ background: 'rgba(107,114,128,0.1)', color: '#6b7280', border: '1px solid rgba(107,114,128,0.2)' }}><StatusDot status="offline" label="Critical" /> {criticalCount} Critical</span>}
        </div>
      )}

      {/* Urgent assets alert */}
      {urgentAssets.length > 0 && (
        <div className="rounded-lg px-4 py-3 mb-6 text-sm flex items-center gap-2"
             style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {urgentAssets.length} asset{urgentAssets.length > 1 ? 's' : ''} in Poor or Critical condition — budget for replacement.
        </div>
      )}

      {realAssets.length === 0 && placeholderTypes.length === 0 ? (
        <Card className="text-center py-16">
          <p className="text-muted-themed text-sm mb-4">No assets tracked yet.</p>
          <p className="text-muted-themed text-sm">
            Go to a{' '}
            <Link href="/properties" className="underline" style={{ color: 'var(--accent-blue)' }}>
              property page
            </Link>{' '}
            and add appliances, HVAC, roofing, and more.
          </p>
        </Card>
      ) : (
        <Card>
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
                {realAssets.map((asset) => {
                  const ageYears = asset.installation_date
                    ? new Date().getFullYear() - new Date(asset.installation_date).getFullYear()
                    : null
                  const score  = asset.health_score
                  const color  = score !== null ? healthColor(score) : '#6b7280'
                  const bg     = score !== null ? healthBgStyle(score) : 'rgba(107,114,128,0.1)'
                  const dot    = score !== null ? healthDot(score) : 'unknown'
                  const label  = score !== null ? healthLabel(score) : 'Unknown'

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
                        {ageYears !== null ? `${ageYears}y` : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {score !== null ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
                            style={{ color, background: bg, border: `1px solid ${color}44` }}
                          >
                            <StatusDot status={dot} label={label} /> {score}/100 · {label}
                          </span>
                        ) : (
                          <Badge tone="slate">Unknown</Badge>
                        )}
                      </td>
                    </tr>
                  )
                })}

                {placeholderTypes.map((assetType) => (
                  <tr key={`placeholder-${assetType}`} className="opacity-70">
                    <td className="px-4 py-3">
                      <span className="font-medium text-primary-themed">{typeLabel(assetType)}</span>
                      <Badge tone="slate" className="text-xs ml-2">Awaiting Discovery</Badge>
                    </td>
                    <td className="px-4 py-3 text-secondary-themed">{selectedPropertyName}</td>
                    <td className="px-4 py-3 text-muted-themed hidden sm:table-cell">—</td>
                    <td className="px-4 py-3 text-muted-themed hidden sm:table-cell">—</td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-muted-themed">Pending Crew Capture</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  accent,
}: Readonly<{
  label:   string
  value:   string | number
  accent?: string
}>) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-xs text-muted-themed">{label}</p>
      <p
        className="text-2xl font-bold"
        style={{ color: accent ?? 'var(--text-primary)' }}
      >
        {value}
      </p>
    </Card>
  )
}
