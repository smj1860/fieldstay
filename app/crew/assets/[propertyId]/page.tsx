'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId } from '@/lib/dexie/context'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Camera, CheckCircle2, Loader2, Wrench, ClipboardCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { submitWorkOrderReport } from '@/lib/dexie/helpers'
import { enqueueMutation } from '@/lib/dexie/syncService'
import { savePendingPhotoBlob, compressPhotoForQueue } from '@/lib/dexie/photo-queue'
import { processPendingPhotoUploads } from '@/lib/dexie/photo-sync'
import { assetTypeDisplayName, missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
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
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-themed" />
      </div>
    )
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

// ── Discovery Capture Modal ────────────────────────────────────────────────────

function DiscoveryCaptureModal({
  propertyId,
  orgId,
  assetType,
  userId,
  onClose,
}: {
  propertyId: string
  orgId:      string
  assetType:  AssetType
  userId:     string
  onClose:    () => void
}) {
  const db = useDexieDb()
  const [make,       setMake]       = useState('')
  const [model,      setModel]      = useState('')
  const [photoFile,  setPhotoFile]  = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [success,    setSuccess]    = useState(false)
  const [scanQueued, setScanQueued] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  /**
   * Offline-first, same pattern as lib/dexie/helpers.ts: write the local
   * Dexie row immediately, then queue the insert through the mutations
   * outbox rather than writing straight to Supabase. A direct write here
   * used to mean a crew member capturing an asset with no signal lost the
   * entry the moment this modal closed — the "everything syncs once you're
   * back online" promise the crew shell's own FAQ makes didn't actually
   * hold for this flow.
   */
  async function saveAsset(
    assetId: string,
    fields: {
      make:       string | null
      model:      string | null
      photoUrl:   string | null
      isNa:       boolean
      scanStatus: 'pending' | null
    },
  ): Promise<void> {
    await db.property_assets.put({
      id:          assetId,
      org_id:      orgId,
      property_id: propertyId,
      asset_type:  assetType,
      make:        fields.make ?? '',
      model:       fields.model ?? '',
      is_na:       fields.isNa ? 1 : 0,
      photo_url:   fields.photoUrl ?? '',
    })

    await enqueueMutation(userId, 'property_assets', assetId, 'PUT', {
      org_id:      orgId,
      property_id: propertyId,
      name:        assetTypeDisplayName(assetType),
      asset_type:  assetType,
      make:        fields.make,
      model:       fields.model,
      photo_url:   fields.photoUrl,
      is_na:       fields.isNa,
      scan_status: fields.scanStatus,
    })
  }

  async function handleMarkNa() {
    setSubmitting(true)
    setError(null)
    try {
      await saveAsset(crypto.randomUUID(), { make: null, model: null, photoUrl: null, isNa: true, scanStatus: null })
      setSuccess(true)
    } catch (err: unknown) {
      setError((err as Error).message || 'Could not save. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!make.trim() && !model.trim() && !photoFile) {
      setError('Add a make/model, a photo, or mark this as not applicable.')
      return
    }
    setSubmitting(true)
    setError(null)

    try {
      const assetId = crypto.randomUUID()
      let photoUrl: string | null = null

      if (photoFile) {
        const supabase = createClient()
        const ext     = photoFile.name.split('.').pop() || 'jpg'
        const path    = `asset-discovery/${propertyId}/${assetType}-${crypto.randomUUID()}.${ext}`
        const blobKey = `photo-asset-${assetId}`

        // getPublicUrl() is pure string templating against the configured
        // project URL — no network call — so the final URL is known before
        // the blob actually reaches Storage. The upload itself is queued
        // below via pending_photo_uploads and may finish well after this
        // handler returns, or after the device comes back online.
        photoUrl = supabase.storage.from('turnover-photos').getPublicUrl(path).data.publicUrl

        const compressed = await compressPhotoForQueue(photoFile)
        await savePendingPhotoBlob(userId, blobKey, compressed)
        await db.pending_photo_uploads.add({
          id:             crypto.randomUUID(),
          target_table:   'property_assets',
          target_id:      assetId,
          target_column:  'photo_url',
          storage_path:   path,
          local_blob_key: blobKey,
          mime_type:      photoFile.type,
          retry_count:    0,
          created_at:     new Date().toISOString(),
        })
      }

      await saveAsset(assetId, {
        make:       make.trim() || null,
        model:      model.trim() || null,
        photoUrl,
        isNa:       false,
        scanStatus: photoFile ? 'pending' : null,
      })

      if (photoFile) {
        // The vision scan itself fires only once the photo actually reaches
        // Storage and photo_url lands server-side (see photo-sync.ts /
        // syncService.ts) — the crew member doesn't wait on it either way;
        // make/model fill in via the realtime sync already watching this
        // property's assets once the background scan completes.
        setScanQueued(true)
        void processPendingPhotoUploads(createClient(), userId)
      }

      setSuccess(true)
    } catch (err: unknown) {
      setError((err as Error).message || 'Could not save. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={success ? 'Saved' : `Capture: ${assetTypeDisplayName(assetType)}`}
      maxWidthClassName="max-w-sm"
      mobileSheet
    >
      {success ? (
        <div className="text-center py-4">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
          <p className="text-sm text-muted-themed mb-4">
            {scanQueued
              ? "Asset saved. We're reading the photo now — make and model will fill in automatically in a moment."
              : 'Asset details saved.'}
          </p>
          <Button onClick={onClose} className="w-full">Done</Button>
        </div>
      ) : (
        <>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              {error}
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="label text-primary-themed">Make</label>
              <Input type="text" value={make} onChange={(e) => setMake(e.target.value)} placeholder="e.g. Samsung" />
            </div>
            <div>
              <label className="label text-primary-themed">Model</label>
              <Input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. RF28" />
            </div>
            <div>
              <label className="label text-primary-themed">Photo of the data plate / sticker (optional)</label>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                className="input"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-xl bg-amber-500 text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save'}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={handleMarkNa}
              className="w-full py-2.5 rounded-xl border border-themed text-sm font-medium text-secondary-themed disabled:opacity-50"
            >
              This property doesn&apos;t have one
            </button>
          </form>
        </>
      )}
    </Dialog>
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
    <Dialog open onClose={onClose} title={success ? 'Work Order Placed' : 'Place a Work Order'} maxWidthClassName="max-w-sm" mobileSheet>
      {success ? (
        <div className="text-center py-4">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
          <p className="text-sm text-muted-themed mb-4">
            Saved. The property manager will see this as soon as your phone has a connection.
          </p>
          <Button onClick={onClose} className="w-full">Done</Button>
        </div>
      ) : (
        <>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              {error}
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="label text-primary-themed">Property</label>
              <Input type="text" value={propertyName} disabled />
            </div>
            <div>
              <label className="label text-primary-themed">Which asset?</label>
              <select
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
              <label className="label text-primary-themed">What&apos;s the issue? *</label>
              <Input
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
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-xl bg-amber-500 text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</> : <><Wrench className="w-4 h-4" /> Submit</>}
            </button>
          </form>
        </>
      )}
    </Dialog>
  )
}
