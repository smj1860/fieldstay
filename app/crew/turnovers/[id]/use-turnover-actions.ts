'use client'
import { useState, useRef, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId, useCrewMemberId } from '@/lib/dexie/context'
import { createClient } from '@/lib/supabase/client'
import { savePendingPhotoBlob, compressPhotoForQueue } from '@/lib/dexie/photo-queue'
import { processPendingPhotoUploads } from '@/lib/dexie/photo-sync'
import {
  updateChecklistItem, startTurnover, completeTurnover, updateInventoryQuantity,
  confirmChecklistComplete, confirmInventoryComplete, markInventoryStarted,
} from '@/lib/dexie/helpers'
import type { ChecklistInstanceItemRow as ChecklistItem, InventoryItemRow as InvRow, PropertyAssetRow } from '@/lib/dexie/schema'
import { assetTypeDisplayName, missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
import type { AssetType } from '@/types/database'

function isAssetDiscovered(asset: Pick<PropertyAssetRow, 'make' | 'model' | 'is_na' | 'photo_url'>): boolean {
  return asset.is_na === 1 || asset.make !== '' || asset.model !== '' || asset.photo_url !== ''
}

/**
 * All derived data + business logic for the crew turnover detail page —
 * extracted out of CrewTurnoverPage so the page component itself is left as
 * routing between TurnoverHub/ChecklistView/InventoryView. Every query
 * filter, dedup, and idempotency behavior below is unchanged from the
 * original inline version — this is pure code motion.
 */
export function useTurnoverActions(id: string) {
  const db           = useDexieDb()
  const userId       = useDexieUserId()
  const crewMemberId = useCrewMemberId()
  const supabase     = createClient()

  const [uploadingItemId,   setUploadingItemId]   = useState<string | null>(null)
  const [uploadError,       setUploadError]       = useState<string | null>(null)
  const [completing,        setCompleting]        = useState(false)
  const [actionError,       setActionError]       = useState<string | null>(null)
  const [counts,            setCounts]            = useState<Record<string, number>>({})
  const [sectionPhotoPrompt, setSectionPhotoPrompt] = useState<string | null>(null)
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

  const runMarkComplete = async (onDone: () => void) => {
    setCompleting(true)
    setActionError(null)
    try {
      await completeTurnover(userId, id)
      onDone()
    } catch (err) {
      console.error('[Crew] completeTurnover failed:', err)
      setCompleting(false)
      setActionError('Could not mark complete. Please check your connection and try again.')
    }
  }

  const markComplete = (onDone: () => void) => {
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
        onConfirm: () => void runMarkComplete(onDone),
      })
      return
    }
    void runMarkComplete(onDone)
  }

  return {
    userId, crewMemberId,
    turnover, property, instance, items, inventoryItems,
    checklistConfirmSyncFailed, inventoryConfirmSyncFailed, pendingUploadIds,
    completedCount, totalCount, pendingPhotos, missingAssetTypes,
    sections, invByCategory,
    uploadingItemId, uploadError, completing, actionError,
    sectionPhotoPrompt, setSectionPhotoPrompt,
    openNoteItemId, setOpenNoteItemId, noteText, setNoteText,
    pendingConfirm, setPendingConfirm,
    fileInputRefs, sectionPhotoRefs,
    toggleItem, saveNote, openNote, handleSectionPhoto, handlePhotoCapture,
    handleCountChange, toggleChecklistConfirm, toggleInventoryConfirm,
    getCount, markInProgress, markComplete,
  }
}

export type TurnoverActions = ReturnType<typeof useTurnoverActions>
