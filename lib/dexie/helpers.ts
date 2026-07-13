import { getDexieDb } from './schema'
import { enqueueMutation, getSyncEngine } from './syncService'

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
 *
 * `crewMemberId` is optional only because useCrewMemberId() can briefly be
 * null before it resolves — pass it whenever available so
 * completed_by_crew_id records who actually did the work. This is what
 * lets two crew members splitting a turnover's checklist see who
 * completed which item.
 */
export async function updateChecklistItem(
  userId: string,
  itemId: string,
  input: UpdateChecklistItemInput,
  crewMemberId?: string | null,
): Promise<void> {
  const db = getDexieDb(userId)
  const completedAt = input.isCompleted ? new Date().toISOString() : null

  const changes: Record<string, unknown> = {
    is_completed: input.isCompleted ? 1 : 0,
    completed_at: completedAt,
  }
  if (crewMemberId) {
    changes.completed_by_crew_id = input.isCompleted ? crewMemberId : ''
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
 * Writes the "Confirm Checklist Complete" (or un-confirm) timestamp/author
 * onto the shared checklist_instances row — a deliberate human assertion
 * distinct from individual item completion, so it doesn't get recomputed
 * from item state. Un-confirming clears both fields; it does not attempt
 * to reopen a turnover that has already fully completed (both checklist
 * and inventory were confirmed) — that would mean reversing side effects
 * (cleaning-fee posting, PM notification) already fired by
 * /api/crew/turnovers/[id]/complete, which is out of scope here.
 */
export async function confirmChecklistComplete(
  userId:       string,
  instanceId:   string,
  crewMemberId: string,
  confirmed:    boolean,
): Promise<void> {
  const db = getDexieDb(userId)

  const changes: Record<string, unknown> = {
    completed_at:         confirmed ? new Date().toISOString() : null,
    completed_by_crew_id: confirmed ? crewMemberId : '',
  }

  await db.checklist_instances.update(instanceId, changes)
  await enqueueMutation(userId, 'checklist_instances', instanceId, 'PATCH', changes)
}

/**
 * Writes the "Confirm Inventory Complete" (or un-confirm) timestamp/author
 * onto the turnover itself — inventory_items has no turnover-scoped table
 * of its own, so this is the only place it can live. Same one-way-into-
 * completion semantics as confirmChecklistComplete above.
 */
export async function confirmInventoryComplete(
  userId:       string,
  turnoverId:   string,
  crewMemberId: string,
  confirmed:    boolean,
): Promise<void> {
  const db = getDexieDb(userId)

  const changes: Record<string, unknown> = {
    inventory_confirmed_complete_at: confirmed ? new Date().toISOString() : null,
    inventory_confirmed_by_crew_id:  confirmed ? crewMemberId : '',
  }

  await db.turnovers.update(turnoverId, changes)
  await enqueueMutation(userId, 'turnovers', turnoverId, 'PATCH', changes)
}

/**
 * Re-queues a mutation that syncService.processOutbox() gave up on after
 * exhausting its retries (marked `failed` rather than deleted — see
 * lib/dexie/syncService.ts). Resets `failed`/`retryCount` on the existing
 * outbox row and kicks processOutbox() again, replaying the same payload
 * that was already queued rather than re-deriving one from current local
 * state — important for confirm actions, where the current local value is
 * already the target state, so re-calling confirmChecklistComplete() with
 * "toggle" semantics would flip it the wrong way instead of retrying.
 */
export async function retryFailedMutation(
  userId: string,
  table:  string,
  targetId: string,
): Promise<void> {
  const db = getDexieDb(userId)
  const failed = await db.mutations
    .where('targetId').equals(targetId)
    .filter((m) => m.table === table && !!m.failed)
    .toArray()

  for (const mutation of failed) {
    await db.mutations.update(mutation.id!, { failed: false, retryCount: 0 })
  }

  void getSyncEngine(userId).processOutbox()
}

/**
 * Records the first time this device touches inventory for this turnover.
 * Callers must guard on the local turnover's inventory_started_at already
 * being null before calling this — there's no server-side "set only if
 * null" guard here (unlike the checklist's DB trigger), since this is a
 * low-stakes bookkeeping field: a rare race between two crew members'
 * devices could at worst overwrite it with a slightly later timestamp,
 * not lose or corrupt anything.
 */
export async function markInventoryStarted(userId: string, turnoverId: string): Promise<void> {
  const db = getDexieDb(userId)
  const startedAt = new Date().toISOString()

  await db.turnovers.update(turnoverId, { inventory_started_at: startedAt })
  await enqueueMutation(userId, 'turnovers', turnoverId, 'PATCH', {
    inventory_started_at: startedAt,
  })
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

/**
 * Saves a crew member's free-text turnover summary/notes for the PM —
 * written straight to turnovers.completion_notes (already rendered on the
 * PM's turnover detail page), not a work order.
 */
export async function submitTurnoverSummaryNotes(
  userId: string,
  turnoverId: string,
  notes: string,
): Promise<void> {
  const db = getDexieDb(userId)
  await db.turnovers.update(turnoverId, { completion_notes: notes })
  await enqueueMutation(userId, 'turnovers', turnoverId, 'PATCH', { completion_notes: notes })
}

/**
 * Places a work order from the crew Assets & Maintenance page: written
 * insert-only, then queued via the outbox. The server derives category from
 * the selected asset and priority from isEmergency — the crew form never
 * asks for either directly.
 */
export async function submitWorkOrderReport(
  userId: string,
  report: {
    propertyId:  string
    assetId:     string | null
    title:       string
    isEmergency: boolean
  },
): Promise<void> {
  const id = crypto.randomUUID()

  await enqueueMutation(userId, 'work_order_reports', id, 'PUT', {
    property_id:  report.propertyId,
    asset_id:     report.assetId,
    title:        report.title,
    is_emergency: report.isEmergency,
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
