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
 *
 * Only fields actually passed in `input` are touched — omitted fields are
 * left as-is locally and aren't included in the outbound mutation, so a
 * plain checkbox toggle never clobbers an existing crew note or photo.
 */
export async function updateChecklistItem(
  userId: string,
  itemId: string,
  input: UpdateChecklistItemInput,
): Promise<void> {
  const db = getDexieDb(userId)
  const completedAt = input.isCompleted ? new Date().toISOString() : null

  const changes: Record<string, unknown> = {
    is_completed: input.isCompleted ? 1 : 0,
    completed_at: completedAt,
  }
  if (input.crewNotes !== undefined) changes.crew_notes = input.crewNotes
  if (input.photoStoragePath !== undefined) changes.photo_storage_path = input.photoStoragePath

  await db.checklist_instance_items.update(itemId, changes)
  await enqueueMutation(userId, 'checklist_instance_items', itemId, 'PATCH', changes)
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

/** Submits a crew-reported issue: written insert-only, then queued via the outbox. */
export async function submitIssueReport(
  userId: string,
  report: {
    turnoverId: string
    orgId:      string
    propertyId: string
    title:      string
    description: string | null
    priority:   string
  },
): Promise<void> {
  const db = getDexieDb(userId)
  const id = crypto.randomUUID()

  await db.turnover_issue_reports.add({
    id,
    turnover_id: report.turnoverId,
    org_id:      report.orgId,
    property_id: report.propertyId,
    title:       report.title,
    description: report.description ?? '',
    priority:    report.priority,
  })

  await enqueueMutation(userId, 'turnover_issue_reports', id, 'PUT', {
    turnover_id: report.turnoverId,
    org_id:      report.orgId,
    property_id: report.propertyId,
    title:       report.title,
    description: report.description,
    priority:    report.priority,
  })
}

/**
 * Creates or updates a crew_availability row. When `id` is omitted a new row
 * is created (queued as a PUT carrying org_id, which SyncEngine's
 * crew_availability handler treats as a full upsert); when `id` is provided
 * an existing row is patched (queued without org_id, which SyncEngine treats
 * as a partial update).
 */
export async function saveCrewAvailability(
  userId: string,
  params: {
    id?:           string
    orgId:         string
    crewMemberId:  string
    date:          string
    isAvailable:   boolean
    notes:         string | null
  },
): Promise<void> {
  const db = getDexieDb(userId)
  const isAvailable = params.isAvailable ? 1 : 0

  if (params.id) {
    await db.crew_availability.update(params.id, {
      is_available: isAvailable,
      notes:        params.notes ?? '',
    })
    await enqueueMutation(userId, 'crew_availability', params.id, 'PATCH', {
      is_available: isAvailable,
      notes:        params.notes,
    })
    return
  }

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  await db.crew_availability.add({
    id,
    org_id:         params.orgId,
    crew_member_id: params.crewMemberId,
    available_date: params.date,
    is_available:   isAvailable,
    notes:          params.notes ?? '',
    created_at:     createdAt,
  })

  await enqueueMutation(userId, 'crew_availability', id, 'PUT', {
    org_id:         params.orgId,
    crew_member_id: params.crewMemberId,
    available_date: params.date,
    is_available:   isAvailable,
    notes:          params.notes,
    created_at:     createdAt,
  })
}
