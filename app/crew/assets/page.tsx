'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb } from '@/lib/dexie/context'
import Link from 'next/link'
import { ClipboardList, ChevronRight } from 'lucide-react'
import { missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
import type { PropertyAssetRow, PropertyRow } from '@/lib/dexie/schema'
import type { AssetType } from '@/types/database'

// Stable identity so the useLiveQuery(...) ?? fallback below doesn't change
// reference every render while a query is still loading.
const EMPTY_ROWS: never[] = []

function isDiscovered(asset: Pick<PropertyAssetRow, 'make' | 'model' | 'is_na' | 'photo_url'>): boolean {
  return asset.is_na === 1 || asset.make !== '' || asset.model !== '' || asset.photo_url !== ''
}

function missingCount(propertyId: string, assets: PropertyAssetRow[]): number {
  const discoveredTypes = new Set(
    assets
      .filter((a) => a.property_id === propertyId && isDiscovered(a))
      .map((a) => a.asset_type as AssetType)
  )
  return missingAssetTypesFromDiscoveredSet(discoveredTypes).length
}

export default function CrewAssetsPage() {
  const db = useDexieDb()

  const turnovers = useLiveQuery(
    () => db.turnovers.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').toArray(),
    []
  ) ?? EMPTY_ROWS

  const workOrders = useLiveQuery(
    () => db.crew_work_orders.filter((wo) => wo.status !== 'completed' && wo.status !== 'cancelled').toArray(),
    []
  ) ?? EMPTY_ROWS

  const propertyIds = [...new Set([
    ...turnovers.map((t) => t.property_id),
    ...workOrders.map((w) => w.property_id),
  ])]
  const propertyIdsKey = propertyIds.join(',')

  const properties = useLiveQuery(
    () => propertyIds.length > 0
      ? db.properties.where('id').anyOf(propertyIds).toArray()
      : Promise.resolve<PropertyRow[]>([]),
    [propertyIdsKey]
  ) ?? []

  const assets = useLiveQuery(
    () => propertyIds.length > 0
      ? db.property_assets.where('property_id').anyOf(propertyIds).toArray()
      : Promise.resolve<PropertyAssetRow[]>([]),
    [propertyIdsKey]
  ) ?? []

  return (
    <div>
      <h2 className="text-lg font-bold text-primary-themed mb-1">Assets & Maintenance</h2>
      <p className="text-sm text-muted-themed mb-4">
        Track down missing appliance details and place work orders for your assigned properties.
      </p>

      {properties.length === 0 && (
        <div className="bg-card-themed rounded-xl border border-themed p-6 text-center">
          <ClipboardList className="w-8 h-8 text-muted-themed mx-auto mb-2" />
          <p className="text-sm text-muted-themed">No assigned properties yet.</p>
        </div>
      )}

      {properties.map((p) => {
        const missing = missingCount(p.id, assets)
        return (
          <Link
            key={p.id}
            href={`/crew/assets/${p.id}`}
            className="flex items-center justify-between rounded-xl border border-themed bg-card-themed p-4 mb-3 active:scale-[0.98] transition-transform"
          >
            <div className="min-w-0">
              <p className="font-bold text-primary-themed text-sm truncate">{p.name}</p>
              {(p.city || p.state) && (
                <p className="text-xs text-muted-themed mt-0.5 truncate">
                  {[p.city, p.state].filter(Boolean).join(', ')}
                </p>
              )}
              {missing > 0 ? (
                <p className="text-xs font-semibold mt-1" style={{ color: 'var(--accent-gold)' }}>
                  {missing} item{missing !== 1 ? 's' : ''} need discovery
                </p>
              ) : (
                <p className="text-xs text-muted-themed mt-1">All assets discovered</p>
              )}
            </div>
            <ChevronRight className="w-4 h-4 text-muted-themed flex-shrink-0" />
          </Link>
        )
      })}
    </div>
  )
}
