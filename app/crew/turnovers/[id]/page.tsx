'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId, useCrewMemberId } from '@/lib/dexie/context'
import { useParams, useRouter }            from 'next/navigation'
import { useState, useRef, useEffect }     from 'react'
import {
  ArrowLeft, Camera, CheckCircle2, Circle,
  Loader2, ImageIcon, AlertCircle,
  Minus, Plus, MapPin, CheckSquare, ChevronRight, Package,
  StickyNote, Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPropertyDateTime } from '@/lib/utils/timezone'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { CrewLoading } from '@/components/crew/CrewLoading'
import { createClient }       from '@/lib/supabase/client'
import { savePendingPhotoBlob, compressPhotoForQueue } from '@/lib/dexie/photo-queue'
import { processPendingPhotoUploads } from '@/lib/dexie/photo-sync'
import {
  updateChecklistItem, startTurnover, completeTurnover, updateInventoryQuantity, submitTurnoverSummaryNotes,
  confirmChecklistComplete, confirmInventoryComplete, markInventoryStarted, retryFailedMutation,
  acknowledgeDatesChanged,
} from '@/lib/dexie/helpers'
import type { ChecklistInstanceItemRow as ChecklistItem, InventoryItemRow as InvRow, PropertyAssetRow } from '@/lib/dexie/schema'
import { assetTypeDisplayName, missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
import type { AssetType } from '@/types/database'

function isAssetDiscovered(asset: Pick<PropertyAssetRow, 'make' | 'model' | 'is_na' | 'photo_url'>): boolean {
  return asset.is_na === 1 || asset.make !== '' || asset.model !== '' || asset.photo_url !== ''
}

export default function CrewTurnoverPage() {
  const { id }   = useParams<{ id: string }>()
  const router   = useRouter()
  const db           = useDexieDb()
  const userId       = useDexieUserId()
  const crewMemberId = useCrewMemberId()
  const supabase     = createClient()

  const [uploadingItemId,   setUploadingItemId]   = useState<string | null>(null)
  const [uploadError,       setUploadError]       = useState<string | null>(null)
  const [completing,        setCompleting]        = useState(false)
  const [actionError,       setActionError]       = useState<string | null>(null)
  const [showFlagModal,     setShowFlagModal]     = useState(false)
  const [counts,            setCounts]            = useState<Record<string, number>>({})
  const [sectionPhotoPrompt, setSectionPhotoPrompt] = useState<string | null>(null)
  const [view, setView] = useState<'hub' | 'checklist' | 'inventory'>('hub')
  const fileInputRefs      = useRef<Record<string, HTMLInputElement | null>>({})
  const sectionPhotoRefs   = useRef<Record<string, HTMLInputElement | null>>({})

  // Note entry — one item open at a time; saves on blur
  const [openNoteItemId, setOpenNoteItemId] = useState<string | null>(null)
  const [noteText,       setNoteText]       = useState('')

  // Replaces native confirm() for "missing photos/assets — continue anyway?"
  // prompts with the app's own Dialog component, matching the confirmation
  // UX used everywhere else in the app.
  const [pendingConfirm, setPendingConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null)

  const turnover = useLiveQuery(() => db.turnovers.get(id), [id])

  const property = useLiveQuery(
    () => turnover ? db.properties.get(turnover.property_id) : undefined,
    [turnover?.property_id]
  ) ?? null

  const instance = useLiveQuery(
    () => db.checklist_instances.where('turnover_id').equals(id).first(),
    [id]
  )

  // Surfaces a dead-lettered "Confirm Checklist/Inventory Complete" write —
  // without this, a mutation that exhausted its sync retries would just
  // vanish from the outbox, and the crew member would have no way to tell
  // their confirmation never actually reached the server.
  const checklistConfirmSyncFailed = useLiveQuery(
    () => instance
      ? db.mutations.where('targetId').equals(instance.id)
          .filter((m) => m.table === 'checklist_instances' && !!m.failed)
          .first()
      : undefined,
    [instance?.id]
  )
  // 'turnovers' mutations are also used by markInventoryStarted/startTurnover/
  // completeTurnover, so disambiguate by payload shape rather than just
  // table+targetId — otherwise this banner could fire for an unrelated
  // failed write against the same turnover row.
  const inventoryConfirmSyncFailed = useLiveQuery(
    () => db.mutations.where('targetId').equals(id)
      .filter((m) => m.table === 'turnovers' && !!m.failed && 'inventory_confirmed_complete_at' in m.payload)
      .first(),
    [id]
  )

  const items = useLiveQuery(
    () => instance
      ? db.checklist_instance_items
          .where('instance_id').equals(instance.id)
          .sortBy('sort_order')
      : [],
    [instance?.id]
  )

  const inventoryItems = useLiveQuery(
    () => turnover
      ? db.inventory_items.where('property_id').equals(turnover.property_id).sortBy('name')
      : [],
    [turnover?.property_id]
  )

  const pendingUploads = useLiveQuery(
    () => db.pending_photo_uploads.where('target_table').equals('checklist_instance_items').toArray(),
    []
  )
  const pendingUploadIds = new Set((pendingUploads ?? []).map(p => p.target_id))

  const completedCount = items?.filter((i) => i.is_completed).length ?? 0
  const totalCount     = items?.length ?? 0
  const pendingPhotos  = items?.filter((i) => i.requires_photo && !i.photo_storage_path) ?? []

  const propertyAssets = useLiveQuery(
    () => turnover
      ? db.property_assets.where('property_id').equals(turnover.property_id).toArray()
      : [],
    [turnover?.property_id]
  ) ?? []
  const missingAssetTypes = missingAssetTypesFromDiscoveredSet(
    new Set(propertyAssets.filter(isAssetDiscovered).map((a) => a.asset_type as AssetType))
  )

  const sections = (items ?? []).reduce<Record<string, ChecklistItem[]>>(
    (acc, item) => {
      if (!acc[item.section_name]) acc[item.section_name] = []
      acc[item.section_name]!.push(item)
      return acc
    },
    {}
  )

  // Group inventory by category
  const invByCategory = (inventoryItems ?? []).reduce<Record<string, InvRow[]>>(
    (acc, item) => {
      if (!acc[item.category]) acc[item.category] = []
      acc[item.category]!.push(item)
      return acc
    },
    {}
  )

  const toggleItem = async (itemId: string, current: number, requiresPhoto: number, photoPath: string | null, sectionName: string) => {
    if (!current && requiresPhoto && !photoPath) {
      fileInputRefs.current[itemId]?.click()
      return
    }
    await updateChecklistItem(userId, itemId, { isCompleted: !current }, crewMemberId)
    // Check if section is now fully complete
    if (!current) {
      const sectionItems = sections[sectionName] ?? []
      const allComplete = sectionItems.every(i => (i.id === itemId ? 1 : i.is_completed))
      if (allComplete && sectionItems.length > 0) {
        setSectionPhotoPrompt(sectionName)
      }
    }
  }

  async function saveNote(itemId: string, isCompleted: number) {
    // Only write if text changed from what's already stored
    const current = items?.find((i) => i.id === itemId)?.crew_notes ?? ''
    if (noteText === current) {
      setOpenNoteItemId(null)
      return
    }
    await updateChecklistItem(userId, itemId, {
      isCompleted: isCompleted === 1,
      crewNotes:   noteText,
    }, crewMemberId)
    setOpenNoteItemId(null)
  }

  function openNote(itemId: string, existingNote: string) {
    setNoteText(existingNote ?? '')
    setOpenNoteItemId(itemId)
  }

  const handleSectionPhoto = async (sectionName: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const ext     = file.name.split('.').pop() ?? 'jpg'
    const path    = `turnover-${id}/section-${sectionName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.${ext}`
    const blobKey = `photo-section-${sectionName}-${Date.now()}`

    try {
      const sectionItem = items?.find((i) => i.section_name === sectionName)
      if (!sectionItem) return

      const compressed = await compressPhotoForQueue(file)
      await savePendingPhotoBlob(userId, blobKey, compressed)
      await db.pending_photo_uploads.add({
        id:             crypto.randomUUID(),
        target_table:   'checklist_instances',
        target_id:      sectionItem.instance_id,
        target_column:  'section_photo_path',
        storage_path:   path,
        local_blob_key: blobKey,
        mime_type:      file.type,
        retry_count:    0,
        created_at:     new Date().toISOString(),
      })

      void processPendingPhotoUploads(supabase, userId)
    } catch (err) {
      console.error('Section photo queueing failed:', err)
      setUploadError('Could not save section photo. Please try again.')
    } finally {
      setSectionPhotoPrompt(null)
      e.target.value = ''
    }
  }

  const handlePhotoCapture = async (itemId: string, file: File) => {
    setUploadingItemId(itemId)
    setUploadError(null)
    try {
      const ext     = file.name.split('.').pop() ?? 'jpg'
      const path    = `turnover-${id}/${itemId}-${Date.now()}.${ext}`
      const blobKey = `photo-${itemId}-${Date.now()}`

      const compressed = await compressPhotoForQueue(file)
      await savePendingPhotoBlob(userId, blobKey, compressed)
      await db.pending_photo_uploads.add({
        id:             crypto.randomUUID(),
        target_table:   'checklist_instance_items',
        target_id:      itemId,
        target_column:  'photo_storage_path',
        storage_path:   path,
        local_blob_key: blobKey,
        mime_type:      file.type,
        retry_count:    0,
        created_at:     new Date().toISOString(),
      })
      await updateChecklistItem(userId, itemId, { isCompleted: true }, crewMemberId)

      // Attempt immediately in case we're actually online — no need to wait
      // for the next interval tick or a reconnect event.
      void processPendingPhotoUploads(supabase, userId)
    } catch (err) {
      console.error('Photo queueing failed:', err)
      setUploadError('Could not save photo. Please try again.')
    } finally {
      setUploadingItemId(null)
    }
  }

  const handleCountChange = async (itemId: string, newQty: number) => {
    const qty = Math.max(0, newQty)
    setCounts((prev) => ({ ...prev, [itemId]: qty }))
    if (!turnover?.inventory_started_at) {
      await markInventoryStarted(userId, id)
    }
    await updateInventoryQuantity(userId, itemId, qty)
  }

  const toggleChecklistConfirm = async () => {
    if (!instance || !crewMemberId) return
    const confirming = !instance.completed_at
    if (confirming && missingAssetTypes.length > 0) {
      setPendingConfirm({
        message:
          `${missingAssetTypes.length} asset${missingAssetTypes.length !== 1 ? 's' : ''} still need discovery ` +
          `(${missingAssetTypes.map(assetTypeDisplayName).join(', ')}). Confirm checklist complete anyway?`,
        onConfirm: () => void confirmChecklistComplete(userId, instance.id, crewMemberId, confirming),
      })
      return
    }
    await confirmChecklistComplete(userId, instance.id, crewMemberId, confirming)
  }

  const toggleInventoryConfirm = async () => {
    if (!crewMemberId) return
    await confirmInventoryComplete(userId, id, crewMemberId, !turnover?.inventory_confirmed_complete_at)
  }

  // Auto-completes the turnover the moment BOTH confirmations are in —
  // whichever crew member's device notices second (its own action, or a
  // Realtime-synced pull revealing the other's) fires this. completeTurnover()
  // is already idempotent server-side, so both devices racing to notice at
  // once is harmless. The manual "Mark Complete" button still exists
  // alongside this for crew who'd find its absence confusing.
  useEffect(() => {
    if (!turnover || turnover.status === 'completed') return
    const checklistConfirmed = !!instance?.completed_at
    const inventoryConfirmed = !!turnover.inventory_confirmed_complete_at
    if (checklistConfirmed && inventoryConfirmed) {
      void completeTurnover(userId, id)
    }
  }, [turnover, instance?.completed_at, userId, id])

  const getCount = (item: InvRow) =>
    counts[item.id] !== undefined ? counts[item.id] : item.current_quantity

  const markInProgress = async () => {
    setActionError(null)
    try {
      await startTurnover(userId, id)
    } catch (err) {
      console.error('[Crew] startTurnover failed:', err)
      setActionError('Could not start this turnover. Please check your connection and try again.')
    }
  }

  const runMarkComplete = async () => {
    setCompleting(true)
    setActionError(null)
    try {
      await completeTurnover(userId, id)
      router.push('/crew')
    } catch (err) {
      console.error('[Crew] completeTurnover failed:', err)
      setCompleting(false)
      setActionError('Could not mark complete. Please check your connection and try again.')
    }
  }

  const markComplete = () => {
    const warnings: string[] = []
    if (pendingPhotos.length > 0) {
      warnings.push(`${pendingPhotos.length} item${pendingPhotos.length !== 1 ? 's' : ''} still need photos`)
    }
    if (missingAssetTypes.length > 0) {
      warnings.push(
        `${missingAssetTypes.length} asset${missingAssetTypes.length !== 1 ? 's' : ''} still need discovery ` +
        `(${missingAssetTypes.map(assetTypeDisplayName).join(', ')})`
      )
    }
    if (warnings.length > 0) {
      setPendingConfirm({
        message:   `${warnings.join('. ')}. Mark complete anyway?`,
        onConfirm: () => void runMarkComplete(),
      })
      return
    }
    void runMarkComplete()
  }

  if (!turnover) {
    return <CrewLoading />
  }

  const fullAddress = [property?.address, property?.city, property?.state].filter(Boolean).join(', ')

  return (
    <div className="min-h-screen pb-24" style={{ background: 'var(--bg-page)' }}>
      {/* Back button — always visible */}
      <button
        onClick={() => view === 'hub' ? router.push('/crew') : setView('hub')}
        className="flex items-center justify-center rounded-lg text-muted-themed hover:text-secondary-themed hover:bg-raised-themed transition-colors mb-4"
        style={{ width: 44, height: 44 }}
        aria-label={view === 'hub' ? 'Back to assignments' : 'Back to turnover'}
      >
        <ArrowLeft className="w-4 h-4" />
      </button>

      {/* Property info card — always visible across all views */}
      <div className="bg-card-themed rounded-xl border border-themed p-4 mb-4">
        <p className="font-bold text-primary-themed text-lg leading-tight">
          {property?.name ?? 'Loading property…'}
        </p>
        {fullAddress && (
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(fullAddress)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-brand-700 flex items-center gap-1 mt-1 hover:underline"
          >
            <MapPin className="w-3 h-3 flex-shrink-0" />
            {fullAddress}
          </a>
        )}

        <div className="mt-3 pt-3 border-t border-themed flex items-center justify-between flex-wrap gap-2">
          <span
            className={cn(
              'text-xs font-semibold px-2 py-0.5 rounded-full',
              turnover.priority !== 'urgent' && turnover.priority !== 'high' && 'bg-raised-themed text-secondary-themed'
            )}
            style={
              turnover.priority === 'urgent'
                ? { background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }
                : turnover.priority === 'high'
                ? { background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' }
                : undefined
            }
          >
            {turnover.priority} priority
          </span>
          {turnover.window_minutes && (
            <span className="text-sm font-semibold text-secondary-themed">
              {Math.floor(turnover.window_minutes / 60)}h
              {turnover.window_minutes % 60 > 0 ? ` ${turnover.window_minutes % 60}m` : ''} window
            </span>
          )}
        </div>

        <div className="mt-2 space-y-1 text-sm">
          <div className="flex gap-3">
            <span className="text-muted-themed w-20 flex-shrink-0">Checkout</span>
            <span className="font-medium text-primary-themed">
              {formatPropertyDateTime(turnover.checkout_datetime, property?.timezone ?? 'America/Chicago')}
            </span>
          </div>
          <div className="flex gap-3">
            <span className="text-muted-themed w-20 flex-shrink-0">Next In</span>
            <span className="font-medium text-primary-themed">
              {formatPropertyDateTime(turnover.checkin_datetime, property?.timezone ?? 'America/Chicago')}
            </span>
          </div>
        </div>

        {/* Checkout/check-in time changed while this turnover was already
            in progress — see lib/turnovers/generator.ts's
            refreshExistingPairDates(). The real checkout_datetime/
            checkin_datetime above are intentionally NOT updated; this only
            informs the crew member so they aren't blindsided, and gives
            them a way to dismiss it once seen. */}
        {turnover.dates_changed_at && !turnover.dates_change_acknowledged_at && (
          <div
            className="mt-3 flex items-start gap-2 rounded-xl px-4 py-3"
            style={{ background: 'var(--accent-amber-dim)', border: '1px solid rgba(245,158,11,0.25)' }}
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-amber)' }} />
            <div className="flex-1">
              <p className="text-sm font-medium" style={{ color: 'var(--accent-amber)' }}>Checkout time changed</p>
              <p className="text-sm mt-0.5" style={{ color: 'var(--accent-amber)' }}>
                The guest&apos;s reservation changed after this turnover started.
                {turnover.pending_checkout_datetime && (
                  <> New checkout: <span className="font-medium">
                    {formatPropertyDateTime(turnover.pending_checkout_datetime, property?.timezone ?? 'America/Chicago')}
                  </span>.</>
                )}
                {turnover.pending_checkin_datetime && (
                  <> New check-in: <span className="font-medium">
                    {formatPropertyDateTime(turnover.pending_checkin_datetime, property?.timezone ?? 'America/Chicago')}
                  </span>.</>
                )}
                {' '}The times above haven&apos;t been changed automatically — let your PM know if this affects your plan.
              </p>
              <button
                type="button"
                onClick={() => { void acknowledgeDatesChanged(userId, id) }}
                className="mt-2 text-sm font-medium underline"
                style={{ color: 'var(--accent-amber)' }}
              >
                Got it
              </button>
            </div>
          </div>
        )}

        {turnover.notes && (
          <p
            className="mt-3 text-sm rounded-lg px-3 py-2 flex items-start gap-1.5"
            style={{ color: 'var(--accent-amber)', background: 'var(--accent-amber-dim)' }}
          >
            <StickyNote className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{turnover.notes}</span>
          </p>
        )}
      </div>

      {/* Upload error banner */}
      {uploadError && (
        <div
          className="flex items-start gap-2 rounded-xl px-4 py-3 mb-4"
          style={{ background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-red)' }} />
          <p className="text-sm" style={{ color: 'var(--accent-red)' }}>{uploadError}</p>
        </div>
      )}

      {/* ── HUB VIEW ── */}
      {view === 'hub' && (
        <div className="space-y-3 mt-4">
          {actionError && (
            <div
              className="px-4 py-3 rounded-xl text-sm font-medium"
              style={{
                backgroundColor: 'var(--accent-red-dim)',
                color:           'var(--accent-red)',
                border:          '1px solid rgba(240,84,84,0.2)',
              }}
            >
              {actionError}
            </div>
          )}

          {/* Progress summary — show checklist completion at a glance */}
          {totalCount > 0 && (
            <div className="rounded-xl px-4 py-3 flex items-center justify-between"
                 style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Checklist progress
              </span>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {completedCount} / {totalCount}
              </span>
            </div>
          )}

          {/* Start Turnover — only if status === 'assigned' */}
          {turnover.status === 'assigned' && (
            <Button variant="secondary" onClick={markInProgress} className="w-full py-4 text-base">
              Start Turnover
            </Button>
          )}

          {/* Navigation buttons */}
          <button
            onClick={() => setView('checklist')}
            className="w-full py-4 rounded-xl flex items-center justify-between px-5 text-base font-medium"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          >
            <div className="flex items-center gap-3">
              <CheckSquare className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />
              Turnover Checklist
            </div>
            <div className="flex items-center gap-2">
              {totalCount > 0 && (
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {completedCount}/{totalCount}
                </span>
              )}
              <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            </div>
          </button>

          {inventoryItems && inventoryItems.length > 0 && (
            <button
              onClick={() => setView('inventory')}
              className="w-full py-4 rounded-xl flex items-center justify-between px-5 text-base font-medium"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            >
              <div className="flex items-center gap-3">
                <Package className="w-5 h-5" style={{ color: 'var(--accent-blue)' }} />
                Inventory
              </div>
              <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            </button>
          )}

          {/* Mark Complete */}
          <Button
            variant="cta"
            onClick={markComplete}
            disabled={completing || turnover.status === 'completed'}
            className="w-full py-4 text-base flex items-center justify-center gap-2
                       disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {completing
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              : turnover.status === 'completed'
              ? <><Check className="w-4 h-4" /> Marked Complete</>
              : 'Mark as Complete'}
          </Button>

          {/* Turnover Summary & Additional Notes — secondary, at the bottom */}
          <button
            onClick={() => setShowFlagModal(true)}
            className="w-full py-3 rounded-xl text-sm font-medium flex items-center
                       justify-center gap-2 border transition-colors hover:opacity-80"
            style={{
              borderColor: 'var(--accent-amber)',
              background:  'var(--accent-amber-dim)',
              color:       'var(--accent-amber)',
            }}
          >
            <StickyNote className="w-4 h-4" />
            Turnover Summary & Additional Notes
          </button>
        </div>
      )}

      {/* ── CHECKLIST VIEW ── */}
      {view === 'checklist' && (
      <div className="mt-2">
        {/* Section header */}
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            Turnover Checklist
          </h2>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {completedCount} of {totalCount}
          </span>
        </div>

      {/* Checklist section */}
      {totalCount > 0 && (
        <>
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-semibold text-secondary-themed">
                Checklist — {completedCount} of {totalCount}
              </span>
              <span className="text-sm text-muted-themed">
                {Math.round((completedCount / totalCount) * 100)}%
              </span>
            </div>
            <div className="h-2 bg-raised-themed rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-300', completedCount !== totalCount && 'bg-brand-800')}
                style={{
                  width:      `${Math.round((completedCount / totalCount) * 100)}%`,
                  background: completedCount === totalCount ? 'var(--accent-green)' : undefined,
                }}
              />
            </div>
            {pendingPhotos.length > 0 && (
              <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
                <Camera className="w-3 h-3" />
                {pendingPhotos.length} item{pendingPhotos.length !== 1 ? 's' : ''} still
                need{pendingPhotos.length === 1 ? 's' : ''} a photo
              </p>
            )}
          </div>

          {Object.entries(sections).map(([sectionName, sectionItems]) => (
            <div key={sectionName} className="mb-4">
              <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2 px-1">
                {sectionName}
              </h3>
              <div className="bg-card-themed rounded-xl border border-themed divide-y divide-themed overflow-hidden">
                {sectionItems.map((item: ChecklistItem) => {
                  const needsPhoto = item.requires_photo && !item.photo_storage_path
                  const uploading  = uploadingItemId === item.id

                  return (
                    <div key={item.id}>
                      <div
                        className={cn('flex items-start gap-3 px-4 py-3', !item.is_completed && 'bg-card-themed')}
                        style={item.is_completed ? { background: 'var(--accent-green-dim)' } : undefined}
                      >
                        <button
                          className="flex-shrink-0 mt-0.5 p-2 -m-2"
                          onClick={() => toggleItem(item.id, item.is_completed, item.requires_photo, item.photo_storage_path, sectionName)}
                          aria-label={item.is_completed ? 'Mark incomplete' : 'Mark complete'}
                        >
                          {item.is_completed
                            ? <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />
                            : <Circle className="w-5 h-5" style={{ color: needsPhoto ? 'var(--accent-amber)' : 'var(--text-muted)' }} />}
                        </button>

                        <button
                          type="button"
                          className="flex-1 min-w-0 cursor-pointer text-left"
                          onClick={() => toggleItem(item.id, item.is_completed, item.requires_photo, item.photo_storage_path, sectionName)}
                        >
                          <p
                            className={cn('text-sm leading-snug', item.is_completed ? 'line-through' : 'text-primary-themed')}
                            style={item.is_completed ? { color: 'var(--accent-green)' } : undefined}
                          >
                            {item.task}
                          </p>
                          {item.crew_notes && openNoteItemId !== item.id && (
                            <p className="text-xs text-muted-themed mt-0.5 italic">Note: {item.crew_notes}</p>
                          )}
                          {item.photo_storage_path && (
                            <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
                              <ImageIcon className="w-3 h-3" /> Photo attached
                            </p>
                          )}
                          {!item.photo_storage_path && pendingUploadIds.has(item.id) && (
                            <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
                              <Loader2 className="w-3 h-3 animate-spin" /> Photo saved — uploading when back online
                            </p>
                          )}
                          {needsPhoto && !uploading && !pendingUploadIds.has(item.id) && (
                            <p className="text-xs mt-0.5" style={{ color: 'var(--accent-amber)' }}>Photo required before completing</p>
                          )}
                          {item.requires_photo && item.photo_reason && (
                            <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
                              <Camera className="w-3.5 h-3.5 flex-shrink-0" /> {item.photo_reason}
                            </p>
                          )}
                        </button>

                        {/* Note toggle button */}
                        <button
                          className="flex-shrink-0 mt-0.5 rounded transition-opacity active:opacity-60 flex items-center justify-center"
                          style={{
                            color:  openNoteItemId === item.id || item.crew_notes ? 'var(--accent-gold)' : 'var(--text-muted)',
                            width:  44,
                            height: 44,
                          }}
                          onClick={() => {
                            if (openNoteItemId === item.id) {
                              void saveNote(item.id, item.is_completed)
                            } else {
                              openNote(item.id, item.crew_notes ?? '')
                            }
                          }}
                          aria-label={openNoteItemId === item.id ? 'Save note' : 'Add note'}
                        >
                          <StickyNote className="w-4 h-4" />
                        </button>

                        {item.requires_photo && (
                          <div className="flex-shrink-0">
                            {uploading ? (
                              <div className="p-1.5"><Loader2 className="w-4 h-4 text-muted-themed animate-spin" /></div>
                            ) : (
                              <button
                                onClick={() => fileInputRefs.current[item.id]?.click()}
                                className="rounded-lg transition-colors flex items-center justify-center"
                                style={{
                                  width:      44,
                                  height:     44,
                                  color:      item.photo_storage_path ? 'var(--accent-green)' : 'var(--accent-amber)',
                                  background: item.photo_storage_path ? 'var(--accent-green-dim)' : 'var(--accent-amber-dim)',
                                }}
                                title={item.photo_storage_path ? 'Replace photo' : 'Tap to take required photo'}
                                aria-label={item.photo_storage_path ? 'Replace photo' : 'Take photo'}
                              >
                                <Camera className="w-4 h-4" />
                              </button>
                            )}
                            <input
                              ref={(el) => { fileInputRefs.current[item.id] = el }}
                              type="file" accept="image/*" capture="environment" className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0]
                                if (file) handlePhotoCapture(item.id, file)
                                e.target.value = ''
                              }}
                            />
                          </div>
                        )}
                      </div>

                      {/* Inline note textarea — appears below the item row */}
                      {openNoteItemId === item.id && (
                        <div className="px-4 pb-3 bg-card-themed border-t border-themed">
                          <textarea
                            autoFocus
                            value={noteText}
                            onChange={(e) => setNoteText(e.target.value)}
                            onBlur={() => void saveNote(item.id, item.is_completed)}
                            rows={2}
                            placeholder="Add a note for this item…"
                            className="w-full mt-2 text-sm rounded-lg px-3 py-2 resize-none border border-themed focus:outline-none focus:border-brand-400"
                            style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
                          />
                          <div className="flex justify-end gap-2 mt-1.5">
                            <button
                              onMouseDown={(e) => {
                                // mousedown fires before blur — prevent blur from saving
                                e.preventDefault()
                                setNoteText(items?.find(i => i.id === item.id)?.crew_notes ?? '')
                                setOpenNoteItemId(null)
                              }}
                              className="text-xs px-2.5 rounded flex items-center justify-center"
                              style={{ color: 'var(--text-muted)', minHeight: 44 }}
                            >
                              Cancel
                            </button>
                            <button
                              onMouseDown={(e) => {
                                e.preventDefault()
                                void saveNote(item.id, item.is_completed)
                              }}
                              className="text-xs px-2.5 rounded font-medium flex items-center justify-center"
                              style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)', minHeight: 44 }}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Section-complete photo prompt */}
              {sectionPhotoPrompt === sectionName && (
                <div
                  className="flex items-center gap-3 mt-2 p-3 rounded-xl border-2 border-dashed"
                  style={{ borderColor: 'var(--accent-gold)', background: 'var(--accent-gold-dim)' }}
                >
                  <Camera className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--accent-gold)' }} />
                  <div className="flex-1 text-sm font-medium" style={{ color: 'var(--accent-gold)' }}>
                    Section complete — add a final photo
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    ref={r => { sectionPhotoRefs.current[sectionName] = r }}
                    onChange={e => handleSectionPhoto(sectionName, e)}
                  />
                  <button
                    onClick={() => sectionPhotoRefs.current[sectionName]?.click()}
                    className="text-xs font-semibold px-3 rounded-lg flex items-center justify-center"
                    style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)', minHeight: 44, minWidth: 44 }}
                  >
                    Take Photo
                  </button>
                  <button
                    onClick={() => setSectionPhotoPrompt(null)}
                    className="text-xs px-2 rounded-lg text-muted-themed hover:bg-raised-themed flex items-center justify-center"
                    style={{ minHeight: 44, minWidth: 44 }}
                  >
                    Skip
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Confirm Checklist Complete — a deliberate human assertion,
              separate from per-item completion. Blocked while required
              photos are missing (same condition the manual "Mark Complete"
              button already checks); allows unchecking to correct a
              premature confirmation, as long as the turnover itself hasn't
              already fully completed. */}
          {instance && (
            <button
              type="button"
              onClick={() => void toggleChecklistConfirm()}
              disabled={
                (!instance.completed_at && pendingPhotos.length > 0)
                || turnover.status === 'completed'
              }
              className={cn(
                'w-full flex items-center gap-3 px-4 py-4 rounded-xl border-2 mt-2 mb-4 text-left transition-colors',
                !instance.completed_at && pendingPhotos.length > 0
                  ? 'border-themed opacity-60 cursor-not-allowed'
                  : !instance.completed_at && 'border-themed hover:bg-raised-themed',
                turnover.status === 'completed' && 'cursor-not-allowed'
              )}
              style={instance.completed_at ? { borderColor: 'var(--accent-green)', background: 'var(--accent-green-dim)' } : undefined}
            >
              {instance.completed_at
                ? <CheckCircle2 className="w-6 h-6 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
                : <Circle className="w-6 h-6 text-muted-themed flex-shrink-0" />}
              <div className="flex-1">
                <p className="text-base font-semibold" style={{ color: instance.completed_at ? 'var(--accent-green)' : 'var(--text-primary)' }}>
                  Confirm Checklist Complete
                </p>
                {!instance.completed_at && pendingPhotos.length > 0 && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--accent-amber)' }}>
                    {pendingPhotos.length} photo{pendingPhotos.length !== 1 ? 's' : ''} still required
                  </p>
                )}
              </div>
            </button>
          )}

          {checklistConfirmSyncFailed && (
            <div
              className="flex items-center justify-between gap-2 -mt-3 mb-4 px-4 py-2 rounded-lg text-xs"
              style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
            >
              <span>Confirmation didn&rsquo;t sync — check your connection.</span>
              <button
                type="button"
                className="font-semibold underline flex-shrink-0"
                onClick={() => void retryFailedMutation(userId, 'checklist_instances', instance!.id)}
              >
                Retry
              </button>
            </div>
          )}
        </>
      )}

      {totalCount === 0 && (
        <div className="bg-card-themed rounded-xl border border-themed p-6 text-center text-muted-themed text-sm mb-4">
          No checklist for this turnover.
        </div>
      )}

        {/* After the checklist, a sticky "Done" button to return to hub */}
        <div className="sticky bottom-0 pt-3 pb-6" style={{ background: 'var(--bg-page)' }}>
          <Button
            variant="secondary"
            onClick={() => setView('hub')}
            className="w-full py-3"
          >
            ← Back to Turnover
          </Button>
        </div>
      </div>
      )}

      {/* ── INVENTORY VIEW ── */}
      {view === 'inventory' && (
      <div className="mt-2">
        <h2 className="text-base font-semibold mb-3 px-1" style={{ color: 'var(--text-primary)' }}>
          Inventory
        </h2>

      {/* Inventory section */}
      {inventoryItems && inventoryItems.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2 px-1">
            Inventory
          </h3>
          <div className="space-y-3">
            {Object.entries(invByCategory).map(([category, catItems]) => (
              <div key={category}>
                <p className="text-xs text-muted-themed font-medium uppercase tracking-wide mb-1.5 px-1">
                  {category.replace(/_/g, ' ')}
                </p>
                <div className="bg-card-themed rounded-xl border border-themed divide-y divide-themed overflow-hidden">
                  {catItems.map((item) => {
                    const qty    = getCount(item)
                    const isLow  = qty < item.par_level
                    return (
                      <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-primary-themed truncate">{item.name}</p>
                          <p className="text-xs text-muted-themed">
                            Par {item.par_level} {item.unit}
                            {isLow && (
                              <span className="ml-1.5 font-medium" style={{ color: 'var(--accent-amber)' }}>· Low</span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => handleCountChange(item.id, qty - 1)}
                            className="rounded-lg border border-themed flex items-center justify-center text-muted-themed hover:bg-raised-themed active:bg-raised-themed transition-colors"
                            style={{ width: 48, height: 48 }}
                            aria-label={`Decrease ${item.name}`}
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <input
                            type="number"
                            min={0}
                            value={qty}
                            onChange={(e) => handleCountChange(item.id, parseInt(e.target.value, 10) || 0)}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              e.preventDefault()
                              const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-inv-count-input]'))
                              const idx = inputs.indexOf(e.currentTarget)
                              inputs[idx + 1]?.focus()
                            }}
                            data-inv-count-input
                            aria-label={`${item.name} count`}
                            className="w-12 text-center text-sm font-semibold text-primary-themed border border-themed rounded-lg py-1 focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
                            style={{ height: 48 }}
                          />
                          <button
                            onClick={() => handleCountChange(item.id, qty + 1)}
                            className="rounded-lg border border-themed flex items-center justify-center text-muted-themed hover:bg-raised-themed active:bg-raised-themed transition-colors"
                            style={{ width: 48, height: 48 }}
                            aria-label={`Increase ${item.name}`}
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-themed text-center mt-2">Inventory updates save automatically</p>
        </div>
      )}

      {/* Confirm Inventory Complete — no validation condition exists to
          block this on (unlike the checklist's required-photo check), so
          it's a pure assertion. Same unchecking/lock-once-completed rules
          as the checklist confirm box. */}
      <button
        type="button"
        onClick={() => void toggleInventoryConfirm()}
        disabled={turnover.status === 'completed'}
        className={cn(
          'w-full flex items-center gap-3 px-4 py-4 rounded-xl border-2 mt-2 mb-4 text-left transition-colors',
          !turnover.inventory_confirmed_complete_at && 'border-themed hover:bg-raised-themed',
          turnover.status === 'completed' && 'cursor-not-allowed'
        )}
        style={turnover.inventory_confirmed_complete_at ? { borderColor: 'var(--accent-green)', background: 'var(--accent-green-dim)' } : undefined}
      >
        {turnover.inventory_confirmed_complete_at
          ? <CheckCircle2 className="w-6 h-6 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
          : <Circle className="w-6 h-6 text-muted-themed flex-shrink-0" />}
        <p className="text-base font-semibold" style={{ color: turnover.inventory_confirmed_complete_at ? 'var(--accent-green)' : 'var(--text-primary)' }}>
          Confirm Inventory Complete
        </p>
      </button>

      {inventoryConfirmSyncFailed && (
        <div
          className="flex items-center justify-between gap-2 -mt-3 mb-4 px-4 py-2 rounded-lg text-xs"
          style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
        >
          <span>Confirmation didn&rsquo;t sync — check your connection.</span>
          <button
            type="button"
            className="font-semibold underline flex-shrink-0"
            onClick={() => void retryFailedMutation(userId, 'turnovers', id)}
          >
            Retry
          </button>
        </div>
      )}

        <div className="sticky bottom-0 pt-3 pb-6" style={{ background: 'var(--bg-page)' }}>
          <Button
            variant="secondary"
            onClick={() => setView('hub')}
            className="w-full py-3"
          >
            ← Back to Turnover
          </Button>
        </div>
      </div>
      )}

      {/* Turnover summary notes modal — always available regardless of view */}
      {showFlagModal && (
        <TurnoverSummaryModal
          turnoverId={turnover.id}
          initialNotes={turnover.completion_notes}
          userId={userId}
          onClose={() => setShowFlagModal(false)}
        />
      )}

      {/* Missing photos/assets confirmation — replaces native confirm() */}
      {pendingConfirm && (
        <Dialog
          open
          onClose={() => setPendingConfirm(null)}
          title="Continue anyway?"
          maxWidthClassName="max-w-sm"
          mobileSheet
        >
          <p className="text-sm text-secondary-themed mb-4">{pendingConfirm.message}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPendingConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="cta"
              onClick={() => {
                pendingConfirm.onConfirm()
                setPendingConfirm(null)
              }}
            >
              Confirm
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

// ── Turnover Summary & Additional Notes Modal ─────────────────────────────────

function TurnoverSummaryModal({
  turnoverId,
  initialNotes,
  userId,
  onClose,
}: {
  turnoverId:   string
  initialNotes: string
  userId:       string
  onClose:      () => void
}) {
  const [notes,      setNotes]      = useState(initialNotes)
  const [submitting, setSubmitting] = useState(false)
  const [success,    setSuccess]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!notes.trim()) { setError('Please add a note for the property manager.'); return }
    setSubmitting(true)
    setError(null)

    try {
      await submitTurnoverSummaryNotes(userId, turnoverId, notes.trim())
      setSuccess(true)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={success ? 'Notes Saved' : 'Turnover Summary & Additional Notes'} maxWidthClassName="max-w-sm" mobileSheet>
      {success ? (
        <div className="text-center py-4">
          <CheckCircle2 className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--accent-green)' }} />
          <p className="text-sm text-muted-themed mb-4">
            Saved. The property manager will see this on the turnover as soon as
            your phone has a connection.
          </p>
          <Button onClick={onClose} className="w-full">Done</Button>
        </div>
      ) : (
        <>
          {error && (
            <div
              className="text-sm rounded-lg px-3 py-2 mb-3"
              style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="turnover-summary-notes" className="label text-primary-themed">Anything the PM should know? *</label>
              <textarea
                id="turnover-summary-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="input resize-none"
                placeholder="A summary of the turnover, anything unusual, or additional notes for the property manager…"
                required
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: 'var(--accent-amber)', color: 'var(--text-inverse)' }}
            >
              {submitting
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                : <><StickyNote className="w-4 h-4" /> Save Notes</>
              }
            </button>
          </form>
        </>
      )}
    </Dialog>
  )
}
