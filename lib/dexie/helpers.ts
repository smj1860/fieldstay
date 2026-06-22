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

/**
 * Marks a turnover in_progress locally and queues the mutation. SyncEngine
 * routes 'in_progress' through /api/crew/turnovers/[id]/start so started_at
 * is set authoritatively by the server, not the client clock.
 */
export async function startTurnover(userId: string, turnoverId: string): Promise<void> {
  const db = getDexieDb(userId)

  await db.turnovers.update(turnoverId, { status: 'in_progress' })

  await enqueueMutation(userId, 'turnovers', turnoverId, 'PATCH', {
    status: 'in_progress',
  })
}

/**
 * Marks a turnover completed locally and queues the mutation. SyncEngine
 * routes 'completed' through /api/crew/turnovers/[id]/complete so the
 * cleaning-fee posting, PM notification, and crew-duration tracking
 * pipeline fires for crew completions.
 */
export async function completeTurnover(userId: string, turnoverId: string): Promise<void> {
  const db = getDexieDb(userId)

  await db.turnovers.update(turnoverId, { status: 'completed' })

  await enqueueMutation(userId, 'turnovers', turnoverId, 'PATCH', {
    status: 'completed',
  })
}

/** Updates an inventory item's on-hand quantity locally and queues the mutation. */
export async function updateInventoryQuantity(
  userId: string,
  itemId: string,
  currentQuantity: number,
): Promise<void> {
  const db = getDexieDb(userId)

  await db.inventory_items.update(itemId, { current_quantity: currentQuantity })

  await enqueueMutation(userId, 'inventory_items', itemId, 'PATCH', {
    current_quantity: currentQuantity,
  })
}
