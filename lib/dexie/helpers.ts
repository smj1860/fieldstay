import { getDexieDb } from './schema'
import { enqueueMutation } from './syncService'

export interface UpdateChecklistItemInput {
  isCompleted:       boolean
  crewNotes?:        string
  photoStoragePath?: string | null
}

/**
 * Offline-first pattern: write the change to the local Dexie cache
 * immediately (so the UI updates with zero latency), queue the change in
 * the `mutations` outbox, then kick off processOutbox() in the background.
 * The caller never awaits the network round-trip.
 */
export async function updateChecklistItem(
  userId: string,
  itemId: string,
  input: UpdateChecklistItemInput,
): Promise<void> {
  const db = getDexieDb(userId)
  const completedAt = input.isCompleted ? new Date().toISOString() : null

  await db.checklist_instance_items.update(itemId, {
    is_completed:       input.isCompleted ? 1 : 0,
    completed_at:       completedAt,
    crew_notes:         input.crewNotes ?? '',
    photo_storage_path: input.photoStoragePath ?? null,
  })

  await enqueueMutation(userId, 'checklist_instance_items', itemId, 'PATCH', {
    is_completed:       input.isCompleted ? 1 : 0,
    completed_at:       completedAt,
    crew_notes:         input.crewNotes ?? '',
    photo_storage_path: input.photoStoragePath ?? null,
  })
  // enqueueMutation already fires processOutbox() in the background —
  // intentionally not awaited here so the caller returns as soon as the
  // local write lands.
}
