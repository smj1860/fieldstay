'use client'

import { useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { useDexieDb } from '@/lib/dexie/context'
import { createClient } from '@/lib/supabase/client'
import { orgScopedStoragePath } from '@/lib/storage/object-path'
import { enqueueMutation } from '@/lib/dexie/syncService'
import { savePendingPhotoBlob } from '@/lib/dexie/photo-queue'
import { compressPhoto } from '@/lib/images/compress'
import { processPendingPhotoUploads } from '@/lib/dexie/photo-sync'
import { assetTypeDisplayName } from '@/lib/asset-discovery/config'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { AssetType } from '@/types/database'

// ── Discovery Capture Modal ──────────────────────────────────────────────────
//
// Extracted from app/crew/assets/[propertyId]/page.tsx so the TURNOVER
// checklist can open the same form. The Asset Discovery items the turnover
// generator writes had no route to a capture form at all — they rendered as
// ordinary tick-boxes, and ticking one wrote nothing to property_assets, so
// the engine handed the same prompt out again on the next turnover forever.
// One modal, so the two entry points cannot drift into capturing different
// things.

export function DiscoveryCaptureModal({
  propertyId,
  orgId,
  assetType,
  userId,
  onClose,
  onCaptured,
}: {
  propertyId: string
  orgId:      string
  assetType:  AssetType
  userId:     string
  onClose:    () => void
  /**
   * Fired once the capture has been written locally and queued. The turnover
   * checklist uses it to tick its own Asset Discovery item, so the prompt and
   * the captured data cannot disagree. Not awaited — the modal's own success
   * state does not depend on what the caller does with it.
   */
  onCaptured?: () => void
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
      photoPath:  string | null
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
      photo_url:   fields.photoPath ?? '',
    })

    await enqueueMutation(userId, 'property_assets', assetId, 'PUT', {
      org_id:      orgId,
      property_id: propertyId,
      name:        assetTypeDisplayName(assetType),
      asset_type:  assetType,
      make:        fields.make,
      model:       fields.model,
      photo_url:   fields.photoPath,
      is_na:       fields.isNa,
      scan_status: fields.scanStatus,
    })
  }

  async function handleMarkNa() {
    setSubmitting(true)
    setError(null)
    try {
      await saveAsset(crypto.randomUUID(), { make: null, model: null, photoPath: null, isNa: true, scanStatus: null })
      onCaptured?.()
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
      let photoPath: string | null = null

      if (photoFile) {
        const ext     = photoFile.name.split('.').pop() || 'jpg'
        const path    = orgScopedStoragePath(orgId, 'asset-discovery', propertyId, `${assetType}-${crypto.randomUUID()}.${ext}`)
        const blobKey = `photo-asset-${assetId}`

        // property_assets.photo_url stores the BARE object key, not a URL.
        // turnover-photos is a private bucket, so a public URL would 400 and
        // a signed one would expire; the key is stable and can be signed on
        // demand by whoever needs to read it. Known before the blob actually
        // reaches Storage — the upload is queued below via
        // pending_photo_uploads and may finish well after this handler
        // returns, or after the device comes back online.
        photoPath = path

        const compressed = await compressPhoto(photoFile)
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
        photoPath,
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

      onCaptured?.()
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
      footer={
        success ? (
          <Button onClick={onClose} className="w-full">Done</Button>
        ) : (
          <div className="w-full space-y-3">
            <button
              type="submit"
              form="discovery-capture-form"
              disabled={submitting}
              className="w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: 'var(--accent-amber)', color: 'var(--bg-page)' }}
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
          </div>
        )
      }
    >
      {success ? (
        <div className="text-center py-4">
          <CheckCircle2 className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--accent-green)' }} />
          <p className="text-sm text-muted-themed">
            {scanQueued
              ? "Asset saved. We're reading the photo now — make and model will fill in automatically in a moment."
              : 'Asset details saved.'}
          </p>
        </div>
      ) : (
        <>
          {error && (
            <div
              className="text-sm border rounded-lg px-3 py-2 mb-3"
              style={{
                color:       'var(--accent-red)',
                background:  'var(--accent-red-dim)',
                borderColor: 'var(--accent-red)',
              }}
            >
              {error}
            </div>
          )}
          <form id="discovery-capture-form" onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="discovery-make" className="label text-primary-themed">Make</label>
              <Input id="discovery-make" type="text" value={make} onChange={(e) => setMake(e.target.value)} placeholder="e.g. Samsung" />
            </div>
            <div>
              <label htmlFor="discovery-model" className="label text-primary-themed">Model</label>
              <Input id="discovery-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. RF28" />
            </div>
            <div>
              <label htmlFor="discovery-photo" className="label text-primary-themed">Photo of the data plate / sticker (optional)</label>
              <input
                id="discovery-photo"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                className="input"
              />
            </div>
          </form>
        </>
      )}
    </Dialog>
  )
}
