'use client'

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { healthLabel, healthColor, healthBgStyle, healthDot } from '@/lib/assets/health-score'
import { assetTypeDisplayName, missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
import { StatusDot } from '@/components/ui/StatusDot'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import type { AssetType, AssetTypeStandard, PropertyAsset } from '@/types/database'

interface Property { id: string; name: string; city: string | null; state: string | null }

function isDiscovered(asset: Pick<PropertyAsset, 'make' | 'model' | 'is_na' | 'photo_url'>): boolean {
  return asset.is_na === true || asset.make !== null || asset.model !== null || asset.photo_url !== null
}

function missingTypesForProperty(propertyId: string, assets: PropertyAsset[]): AssetType[] {
  const discoveredTypes = new Set(
    assets
      .filter((a) => a.property_id === propertyId)
      .filter(isDiscovered)
      .map((a) => a.asset_type as AssetType)
  )
  return missingAssetTypesFromDiscoveredSet(discoveredTypes)
}

function assetAgeYears(asset: Pick<PropertyAsset, 'installation_date'>): number | null {
  return asset.installation_date
    ? new Date().getFullYear() - new Date(asset.installation_date).getFullYear()
    : null
}

function assetHealthDisplay(asset: Pick<PropertyAsset, 'health_score'>) {
  const score = asset.health_score
  return {
    score,
    color: score !== null ? healthColor(score) : 'var(--text-muted)',
    bg:    score !== null ? healthBgStyle(score) : 'var(--border)',
    dot:   score !== null ? healthDot(score) : 'unknown',
    label: score !== null ? healthLabel(score) : 'Unknown',
  }
}

export function PortfolioAssetView({
  assets,
  properties,
  standards,
}: Readonly<{
  assets:     PropertyAsset[]
  properties: Property[]
  standards:  AssetTypeStandard[]
}>) {
  const propertyMap = Object.fromEntries(properties.map((p) => [p.id, p.name]))
  const typeLabel = (t: string) =>
    standards.find((s) => s.asset_type === t)?.display_name ?? assetTypeDisplayName(t as AssetType)

  // N/A assets are excluded from totals, averages, and attention counts —
  // they were explicitly marked as not present at the property.
  const realAssets  = assets.filter((a) => !a.is_na)
  const scored      = realAssets.filter((a) => a.health_score !== null)
  const urgentAssets = realAssets.filter((a) => a.health_score !== null && a.health_score < 40)

  const avgScore = scored.length
    ? Math.round(scored.reduce((s, a) => s + a.health_score!, 0) / scored.length)
    : null

  const goodCount     = scored.filter((a) => a.health_score! >= 80).length
  const fairCount     = scored.filter((a) => { const s = a.health_score!; return s >= 60 && s < 80 }).length
  const agingCount    = scored.filter((a) => { const s = a.health_score!; return s >= 40 && s < 60 }).length
  const poorCount     = scored.filter((a) => { const s = a.health_score!; return s >= 20 && s < 40 }).length
  const endOfLifeCount = scored.filter((a) => a.health_score! < 20).length

  // Pending Discovery — system-mandated master list assets not yet captured,
  // summed across the whole portfolio.
  const pendingDiscoveryCount = properties.reduce(
    (sum, p) => sum + missingTypesForProperty(p.id, assets).length,
    0
  )

  return (
    <div>
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
          {endOfLifeCount > 0 && <span className="badge flex items-center gap-1.5" style={{ background: 'var(--border)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)' }}><StatusDot status="offline" label="End of Life" /> {endOfLifeCount} End of Life</span>}
        </div>
      )}

      {/* Urgent assets alert */}
      {urgentAssets.length > 0 && (
        <div className="rounded-lg px-4 py-3 mb-6 text-sm flex items-center gap-2"
             style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {urgentAssets.length} asset{urgentAssets.length > 1 ? 's' : ''} in Poor or End of Life condition — budget for replacement.
        </div>
      )}

      {realAssets.length === 0 && pendingDiscoveryCount === 0 ? (
        <Card className="text-center py-16">
          <p className="text-muted-themed text-sm">
            No assets tracked yet. Switch to the <strong>By Property</strong> tab to add appliances, HVAC, roofing, and more.
          </p>
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          {/* Mobile card layout */}
          <div className="md:hidden divide-y divide-themed">
            {realAssets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                typeLabel={typeLabel(asset.asset_type)}
                propertyName={propertyMap[asset.property_id] ?? '—'}
              />
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-themed">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Asset</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Property</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Make / Model</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Age</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-themed">
                {realAssets.map((asset) => {
                  const ageYears = assetAgeYears(asset)
                  const { color, bg, dot, label, score } = assetHealthDisplay(asset)

                  return (
                    <tr key={asset.id} className="hover:bg-raised-themed transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-medium text-primary-themed">{asset.name}</span>
                        <p className="text-xs text-muted-themed mt-0.5">{typeLabel(asset.asset_type)}</p>
                      </td>
                      <td className="px-4 py-3 text-secondary-themed">
                        {propertyMap[asset.property_id] ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-themed">
                        {[asset.make, asset.model].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-themed">
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

                {properties.flatMap((p) => missingTypesForProperty(p.id, assets).map((assetType) => (
                  <tr key={`placeholder-${p.id}-${assetType}`} className="opacity-70">
                    <td className="px-4 py-3">
                      <span className="font-medium text-primary-themed">{typeLabel(assetType)}</span>
                      <Badge tone="slate" className="text-xs ml-2">Awaiting Discovery</Badge>
                    </td>
                    <td className="px-4 py-3 text-secondary-themed">{propertyMap[p.id] ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-themed">—</td>
                    <td className="px-4 py-3 text-muted-themed">—</td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-muted-themed">Pending Crew Capture</span>
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-themed mt-4">
        Assets link to their property page for edits —{' '}
        <Link href="/assets" className="underline">switch to By Property</Link> to add, edit, or import.
      </p>
    </div>
  )
}

function AssetCard({
  asset,
  typeLabel,
  propertyName,
}: Readonly<{
  asset:        PropertyAsset
  typeLabel:    string
  propertyName: string
}>) {
  const ageYears = assetAgeYears(asset)
  const { color, bg, dot, label, score } = assetHealthDisplay(asset)
  const makeModel = [asset.make, asset.model].filter(Boolean).join(' · ')

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium text-primary-themed">{asset.name}</span>
          <p className="text-xs text-muted-themed mt-0.5">{typeLabel}</p>
        </div>
        {score !== null ? (
          <span
            className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
            style={{ color, background: bg, border: `1px solid ${color}44` }}
          >
            <StatusDot status={dot} label={label} /> {score}/100
          </span>
        ) : (
          <Badge tone="slate" className="flex-shrink-0">Unknown</Badge>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mt-2 text-xs text-muted-themed">
        <span>{propertyName}</span>
        {makeModel && <><span>·</span><span>{makeModel}</span></>}
        {ageYears !== null && <><span>·</span><span>{ageYears}y old</span></>}
      </div>
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
