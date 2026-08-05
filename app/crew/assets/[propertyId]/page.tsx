'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId } from '@/lib/dexie/context'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Camera, CheckCircle2, Loader2, Wrench, ClipboardCheck } from 'lucide-react'
import { submitWorkOrderReport } from '@/lib/dexie/helpers'
import { assetTypeDisplayName, missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
import { CrewLoading } from '@/components/crew/CrewLoading'
import { DiscoveryCaptureModal } from '@/app/crew/_components/discovery-capture-modal'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { PropertyAssetRow } from '@/lib/dexie/schema'
import type { AssetType } from '@/types/database'

function isDiscovered(asset: Pick<PropertyAssetRow, 'make' | 'model' | 'is_na' | 'photo_url'>): boolean {
  return asset.is_na === 1 || asset.make !== '' || asset.model !== '' || asset.photo_url !== ''
}

function assetLabel(asset: PropertyAssetRow): string {
  const typeName = assetTypeDisplayName(asset.asset_type as AssetType)
  const detail = [asset.make, asset.model].filter(Boolean).join(' ')
  return detail ? `${typeName} — ${detail}` : typeName
}

export default function CrewPropertyAssetsPage() {
  const { propertyId } = useParams<{ propertyId: string }>()
  const db     = useDexieDb()
  const userId = useDexieUserId()
  const router = useRouter()

  const [captureType, setCaptureType]     = useState<AssetType | null>(null)
  const [showWorkOrder, setShowWorkOrder] = useState(false)

  const property = useLiveQuery(() => db.properties.get(propertyId), [propertyId])
  const assets = useLiveQuery(
    () => db.property_assets.where('property_id').equals(propertyId).toArray(),
    [propertyId]
  ) ?? []

  const discoveredTypes = new Set(assets.filter(isDiscovered).map((a) => a.asset_type as AssetType))
  const missingTypes = missingAssetTypesFromDiscoveredSet(discoveredTypes)

  if (!property) {
    return <CrewLoading />
  }

  return (
    <div>
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1.5 text-sm text-muted-themed hover:text-secondary-themed mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back
      </button>

      <h2 className="text-lg font-bold text-primary-themed mb-1">{property.name}</h2>
      {(property.city || property.state) && (
        <p className="text-sm text-muted-themed mb-4">
          {[property.city, property.state].filter(Boolean).join(', ')}
        </p>
      )}

      <Button onClick={() => setShowWorkOrder(true)} className="w-full py-3 mb-6 flex items-center justify-center gap-2">
        <Wrench className="w-4 h-4" />
        Place a Work Order
      </Button>

      <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">
        Asset Discovery
      </h3>

      {missingTypes.length === 0 ? (
        <div className="bg-card-themed rounded-xl border border-themed p-6 text-center mb-4">
          <ClipboardCheck className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--accent-gold)' }} />
          <p className="text-sm text-muted-themed">Every required asset has been discovered.</p>
        </div>
      ) : (
        <div className="space-y-2 mb-4">
          {missingTypes.map((assetType) => (
            <button
              key={assetType}
              onClick={() => setCaptureType(assetType)}
              className="w-full flex items-center justify-between rounded-xl border border-themed bg-card-themed p-3 text-left active:scale-[0.98] transition-transform"
            >
              <span className="text-sm font-medium text-primary-themed">
                {assetTypeDisplayName(assetType)}
              </span>
              <span
                className="text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"
                style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
              >
                <Camera className="w-3 h-3" />
                Capture
              </span>
            </button>
          ))}
        </div>
      )}

      {captureType && (
        <DiscoveryCaptureModal
          propertyId={propertyId}
          orgId={property.org_id}
          assetType={captureType}
          userId={userId}
          onClose={() => setCaptureType(null)}
        />
      )}

      {showWorkOrder && (
        <PlaceWorkOrderModal
          propertyId={propertyId}
          propertyName={property.name}
          assets={assets}
          userId={userId}
          onClose={() => setShowWorkOrder(false)}
        />
      )}
    </div>
  )
}

// ── Place Work Order Modal ─────────────────────────────────────────────────────

function PlaceWorkOrderModal({
  propertyId,
  propertyName,
  assets,
  userId,
  onClose,
}: {
  propertyId:   string
  propertyName: string
  assets:       PropertyAssetRow[]
  userId:       string
  onClose:      () => void
}) {
  const [assetId,     setAssetId]     = useState<string>('')
  const [title,       setTitle]       = useState('')
  const [isEmergency, setIsEmergency] = useState(false)
  const [submitting,  setSubmitting]  = useState(false)
  const [success,     setSuccess]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const discoveredAssets = assets.filter((a) => a.is_na === 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) { setError("Please describe the issue."); return }
    setSubmitting(true)
    setError(null)

    try {
      await submitWorkOrderReport(userId, {
        propertyId,
        assetId:     assetId || null,
        title:       title.trim(),
        isEmergency,
      })
      setSuccess(true)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={success ? 'Work Order Placed' : 'Place a Work Order'}
      maxWidthClassName="max-w-sm"
      mobileSheet
      footer={
        success ? (
          <Button onClick={onClose} className="w-full">Done</Button>
        ) : (
          <button
            type="submit"
            form="place-wo-form"
            disabled={submitting}
            className="w-full py-2.5 rounded-xl bg-amber-500 text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</> : <><Wrench className="w-4 h-4" /> Submit</>}
          </button>
        )
      }
    >
      {success ? (
        <div className="text-center py-4">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
          <p className="text-sm text-muted-themed">
            Saved. The property manager will see this as soon as your phone has a connection.
          </p>
        </div>
      ) : (
        <>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              {error}
            </div>
          )}
          <form id="place-wo-form" onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="wo-property" className="label text-primary-themed">Property</label>
              <Input id="wo-property" type="text" value={propertyName} disabled />
            </div>
            <div>
              <label htmlFor="wo-asset" className="label text-primary-themed">Which asset?</label>
              <select
                id="wo-asset"
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
                className="input"
              >
                <option value="">Other / not listed</option>
                {discoveredAssets.map((a) => (
                  <option key={a.id} value={a.id}>{assetLabel(a)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="wo-issue" className="label text-primary-themed">What&apos;s the issue? *</label>
              <Input
                id="wo-issue"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Leaking faucet in master bath"
                required
              />
            </div>
            <label className="flex items-center gap-2 text-sm font-medium text-primary-themed">
              <input
                type="checkbox"
                checked={isEmergency}
                onChange={(e) => setIsEmergency(e.target.checked)}
              />
              This is an emergency
            </label>
          </form>
        </>
      )}
    </Dialog>
  )
}
