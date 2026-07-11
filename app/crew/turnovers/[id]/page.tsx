'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId, useCrewMemberId } from '@/lib/dexie/context'
import { useParams, useRouter }            from 'next/navigation'
import { useState, useRef, useEffect }     from 'react'
import {
  ArrowLeft, Camera, CheckCircle2, Circle,
  Loader2, ImageIcon, AlertCircle, AlertTriangle,
  Minus, Plus, MapPin, CheckSquare, ChevronRight, Package,
  StickyNote, Check,
} from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { createClient }       from '@/lib/supabase/client'
import { savePendingPhotoBlob } from '@/lib/dexie/photo-queue'
import { processPendingPhotoUploads } from '@/lib/dexie/photo-sync'
import {
  updateChecklistItem, startTurnover, completeTurnover, updateInventoryQuantity, submitIssueReport,
  confirmChecklistComplete, confirmInventoryComplete, markInventoryStarted, retryFailedMutation,
} from '@/lib/dexie/helpers'
import type { ChecklistInstanceItemRow as ChecklistItem, InventoryItemRow as InvRow } from '@/lib/dexie/schema'

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

      await savePendingPhotoBlob(userId, blobKey, file)
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

      await savePendingPhotoBlob(userId, blobKey, file)
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
    await confirmChecklistComplete(userId, instance.id, crewMemberId, !instance.completed_at)
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

  const markComplete = async () => {
    if (pendingPhotos.length > 0) {
      const ok = confirm(
        `${pendingPhotos.length} item${pendingPhotos.length !== 1 ? 's' : ''} still need photos. Mark complete anyway?`
      )
      if (!ok) return
    }
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

  if (!turnover) {
    return (
      <div className="text-center py-20 text-muted-themed">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
        <p className="text-sm">Loading…</p>
      </div>
    )
  }

  const fullAddress = [property?.address, property?.city, property?.state].filter(Boolean).join(', ')

  return (
    <div className="min-h-screen pb-24" style={{ background: 'var(--bg-page)' }}>
      {/* Back button — always visible */}
      <button
        onClick={() => view === 'hub' ? router.push('/crew') : setView('hub')}
        className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-themed hover:text-secondary-themed hover:bg-raised-themed transition-colors mb-4"
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
          <span className={cn(
            'text-xs font-semibold px-2 py-0.5 rounded-full',
            turnover.priority === 'urgent' ? 'bg-red-50 text-red-600' :
            turnover.priority === 'high'   ? 'bg-amber-50 text-amber-700' :
            'bg-raised-themed text-secondary-themed'
          )}>
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
            <span className="font-medium text-primary-themed">{formatDateTime(turnover.checkout_datetime)}</span>
          </div>
          <div className="flex gap-3">
            <span className="text-muted-themed w-20 flex-shrink-0">Next In</span>
            <span className="font-medium text-primary-themed">{formatDateTime(turnover.checkin_datetime)}</span>
          </div>
        </div>

        {turnover.notes && (
          <p className="mt-3 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <StickyNote className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{turnover.notes}</span>
          </p>
        )}
      </div>

      {/* Upload error banner */}
      {uploadError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{uploadError}</p>
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
                <Package className="w-5 h-5" style={{ color: 'var(--accent-blue, #3b82f6)' }} />
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

          {/* Report an Issue — secondary, at the bottom */}
          <button
            onClick={() => setShowFlagModal(true)}
            className="w-full py-3 rounded-xl text-sm font-medium flex items-center
                       justify-center gap-2 border border-amber-300 bg-amber-50
                       text-amber-700 hover:bg-amber-100 transition-colors"
          >
            <AlertTriangle className="w-4 h-4" />
            Report an Issue
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
                className={cn('h-full rounded-full transition-all duration-300',
                  completedCount === totalCount ? 'bg-green-500' : 'bg-brand-800'
                )}
                style={{ width: `${Math.round((completedCount / totalCount) * 100)}%` }}
              />
            </div>
            {pendingPhotos.length > 0 && (
              <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
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
                      <div className={cn('flex items-start gap-3 px-4 py-3', item.is_completed ? 'bg-green-50' : 'bg-card-themed')}>
                        <button
                          className="flex-shrink-0 mt-0.5"
                          onClick={() => toggleItem(item.id, item.is_completed, item.requires_photo, item.photo_storage_path, sectionName)}
                        >
                          {item.is_completed
                            ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                            : <Circle className={cn('w-5 h-5', needsPhoto ? 'text-amber-400' : 'text-muted-themed')} />}
                        </button>

                        <button
                          type="button"
                          className="flex-1 min-w-0 cursor-pointer text-left"
                          onClick={() => toggleItem(item.id, item.is_completed, item.requires_photo, item.photo_storage_path, sectionName)}
                        >
                          <p className={cn('text-sm leading-snug',
                            item.is_completed ? 'text-green-700 line-through' : 'text-primary-themed')}>
                            {item.task}
                          </p>
                          {item.crew_notes && openNoteItemId !== item.id && (
                            <p className="text-xs text-muted-themed mt-0.5 italic">Note: {item.crew_notes}</p>
                          )}
                          {item.photo_storage_path && (
                            <p className="text-xs text-green-600 mt-0.5 flex items-center gap-1">
                              <ImageIcon className="w-3 h-3" /> Photo attached
                            </p>
                          )}
                          {!item.photo_storage_path && pendingUploadIds.has(item.id) && (
                            <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" /> Photo saved — uploading when back online
                            </p>
                          )}
                          {needsPhoto && !uploading && !pendingUploadIds.has(item.id) && (
                            <p className="text-xs text-amber-600 mt-0.5">Photo required before completing</p>
                          )}
                          {item.requires_photo && item.photo_reason && (
                            <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
                              <Camera className="w-3.5 h-3.5 flex-shrink-0" /> {item.photo_reason}
                            </p>
                          )}
                        </button>

                        {/* Note toggle button */}
                        <button
                          className="flex-shrink-0 mt-0.5 p-1 rounded transition-opacity active:opacity-60"
                          style={{ color: openNoteItemId === item.id || item.crew_notes ? 'var(--accent-gold)' : 'var(--text-muted)' }}
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
                                className={cn('p-1.5 rounded-lg transition-colors',
                                  item.photo_storage_path
                                    ? 'text-green-600 bg-green-50 hover:bg-green-100'
                                    : 'text-amber-600 bg-amber-50 hover:bg-amber-100'
                                )}
                                title={item.photo_storage_path ? 'Replace photo' : 'Tap to take required photo'}
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
                              className="text-xs px-2.5 py-1 rounded"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              Cancel
                            </button>
                            <button
                              onMouseDown={(e) => {
                                e.preventDefault()
                                void saveNote(item.id, item.is_completed)
                              }}
                              className="text-xs px-2.5 py-1 rounded font-medium"
                              style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)' }}
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
                  style={{ borderColor: '#FCD116', background: 'rgba(252,209,22,0.08)' }}
                >
                  <Camera className="w-5 h-5 flex-shrink-0" style={{ color: '#B8961A' }} />
                  <div className="flex-1 text-sm font-medium" style={{ color: '#B8961A' }}>
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
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#FCD116', color: '#1a1a1a' }}
                  >
                    Take Photo
                  </button>
                  <button
                    onClick={() => setSectionPhotoPrompt(null)}
                    className="text-xs px-2 py-1.5 rounded-lg text-muted-themed hover:bg-raised-themed"
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
                instance.completed_at
                  ? 'border-green-400 bg-green-50'
                  : pendingPhotos.length > 0
                  ? 'border-themed opacity-60 cursor-not-allowed'
                  : 'border-themed hover:bg-raised-themed',
                turnover.status === 'completed' && 'cursor-not-allowed'
              )}
            >
              {instance.completed_at
                ? <CheckCircle2 className="w-6 h-6 text-green-500 flex-shrink-0" />
                : <Circle className="w-6 h-6 text-muted-themed flex-shrink-0" />}
              <div className="flex-1">
                <p className="text-base font-semibold" style={{ color: instance.completed_at ? '#15803d' : 'var(--text-primary)' }}>
                  Confirm Checklist Complete
                </p>
                {!instance.completed_at && pendingPhotos.length > 0 && (
                  <p className="text-xs text-amber-600 mt-0.5">
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
                              <span className="ml-1.5 text-amber-600 font-medium">· Low</span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => handleCountChange(item.id, qty - 1)}
                            className="w-7 h-7 rounded-lg border border-themed flex items-center justify-center text-muted-themed hover:bg-raised-themed active:bg-raised-themed transition-colors"
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
                            className="w-12 text-center text-sm font-semibold text-primary-themed border border-themed rounded-lg py-1 focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
                          />
                          <button
                            onClick={() => handleCountChange(item.id, qty + 1)}
                            className="w-7 h-7 rounded-lg border border-themed flex items-center justify-center text-muted-themed hover:bg-raised-themed active:bg-raised-themed transition-colors"
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
          turnover.inventory_confirmed_complete_at
            ? 'border-green-400 bg-green-50'
            : 'border-themed hover:bg-raised-themed',
          turnover.status === 'completed' && 'cursor-not-allowed'
        )}
      >
        {turnover.inventory_confirmed_complete_at
          ? <CheckCircle2 className="w-6 h-6 text-green-500 flex-shrink-0" />
          : <Circle className="w-6 h-6 text-muted-themed flex-shrink-0" />}
        <p className="text-base font-semibold" style={{ color: turnover.inventory_confirmed_complete_at ? '#15803d' : 'var(--text-primary)' }}>
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

      {/* Flag modal — always available regardless of view */}
      {showFlagModal && (
        <IssueReportModal
          turnover={turnover}
          userId={userId}
          onClose={() => setShowFlagModal(false)}
        />
      )}
    </div>
  )
}

// ── Issue Report Modal ────────────────────────────────────────────────────────

function IssueReportModal({
  turnover,
  userId,
  onClose,
}: {
  turnover: { id: string; org_id: string; property_id: string }
  userId:   string
  onClose:  () => void
}) {
  const [title,      setTitle]      = useState('')
  const [details,    setDetails]    = useState('')
  const [priority,   setPriority]   = useState<'medium' | 'high' | 'urgent'>('medium')
  const [submitting, setSubmitting] = useState(false)
  const [success,    setSuccess]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) { setError('Please describe the issue.'); return }
    setSubmitting(true)
    setError(null)

    try {
      await submitIssueReport(userId, {
        turnoverId:  turnover.id,
        orgId:       turnover.org_id,
        propertyId:  turnover.property_id,
        title:       title.trim(),
        description: details.trim() || null,
        priority,
      })
      setSuccess(true)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={success ? 'Issue Reported' : 'Report an Issue'} maxWidthClassName="max-w-sm" mobileSheet>
      {success ? (
        <div className="text-center py-4">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
          <p className="text-sm text-muted-themed mb-4">
            Saved. The property manager will be notified and a work order created as
            soon as your phone has a connection.
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
              <label className="label text-primary-themed">What&apos;s the issue? *</label>
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Leaking faucet in master bath"
                required
              />
            </div>
            <div>
              <label className="label text-primary-themed">Details (optional)</label>
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={2}
                className="input resize-none"
                placeholder="Location, severity, anything else the PM should know…"
              />
            </div>
            <div>
              <label className="label text-primary-themed">Urgency</label>
              <div className="flex gap-2">
                {(['medium', 'high', 'urgent'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors capitalize',
                      priority === p
                        ? p === 'urgent' ? 'bg-red-500 text-white border-red-500'
                          : p === 'high' ? 'bg-amber-500 text-white border-amber-500'
                          : 'bg-blue-500 text-white border-blue-500'
                        : 'bg-card-themed text-secondary-themed border-themed hover:border-themed'
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-xl bg-amber-500 text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
                : <><AlertTriangle className="w-4 h-4" /> Submit Report</>
              }
            </button>
          </form>
        </>
      )}
    </Dialog>
  )
}
