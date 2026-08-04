import { getDexieDb, isDexieShutdown, type FieldStayDexie, type MutationRow } from './schema'
import { reportError } from '@/lib/observability/report-error'
import { enqueueMutation, enqueueMutationTx, getSyncEngine } from './syncService'
import { invalidateCursorsFor } from './sync/cursors'

/**
 * Commits an optimistic local write and its outbox row in ONE Dexie
 * transaction, then kicks the drain.
 *
 * The two writes used to be separate IndexedDB transactions. A PWA reclaimed
 * between them (iOS backgrounding, a quota error, a closed tab) left the cache
 * updated with nothing queued to send it: the crew member saw the change as
 * saved forever, the server never heard about it, the failed-sync banner had
 * no row to show, and no delta pull would ever correct it because the server
 * row's updated_at never changed. See enqueueMutationTx().
 *
 * `apply` may only touch Dexie. Anything that awaits a non-Dexie promise
 * inside the transaction lets IndexedDB auto-commit it early, and the rest of
 * the block throws TransactionInactiveError — which is precisely why the
 * processOutbox() kick is outside it.
 */
async function writeAndQueue(
  userId:   string,
  table:    MutationRow['table'],
  targetId: string,
  op:       MutationRow['op'],
  payload:  Record<string, unknown>,
  apply:    (db: FieldStayDexie) => Promise<unknown>,
): Promise<void> {
  if (isDexieShutdown(userId)) return
  const db = getDexieDb(userId)

  // Array form: Dexie's variadic transaction() overloads stop at five tables,
  // and every store a helper might touch has to be in scope up front — an IDB
  // transaction cannot widen its scope once it has started.
  await db.transaction('rw', [
    db.mutations,
    db.turnovers,
    db.checklist_instances,
    db.checklist_instance_items,
    db.inventory_items,
    db.crew_availability,
    db.crew_work_orders,
    db.property_assets,
    db.sync_meta,
  ], async () => {
    await apply(db)
    await enqueueMutationTx(db, table, targetId, op, payload)
  })

  void getSyncEngine(userId).processOutbox()
}

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

  await writeAndQueue(userId, 'checklist_instance_items', itemId, 'PATCH', changes, (db) =>
    db.checklist_instance_items.update(itemId, changes),
  )
  // writeAndQueue fires processOutbox() in the background — intentionally not
  // awaited, so the caller returns as soon as the local write lands.
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
  const changes: Record<string, unknown> = {
    completed_at:         confirmed ? new Date().toISOString() : null,
    completed_by_crew_id: confirmed ? crewMemberId : '',
  }

  await writeAndQueue(userId, 'checklist_instances', instanceId, 'PATCH', changes, (db) =>
    db.checklist_instances.update(instanceId, changes),
  )
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
  const changes: Record<string, unknown> = {
    inventory_confirmed_complete_at: confirmed ? new Date().toISOString() : null,
    inventory_confirmed_by_crew_id:  confirmed ? crewMemberId : '',
  }

  await writeAndQueue(userId, 'turnovers', turnoverId, 'PATCH', changes, (db) =>
    db.turnovers.update(turnoverId, changes),
  )
}

/**
 * Acknowledges a staged checkout/checkin date change on an in_progress
 * turnover (see lib/turnovers/generator.ts's refreshExistingPairDates()).
 * Dismisses the "checkout time changed" banner without applying the
 * pending times — the real checkout_datetime/checkin_datetime are left
 * as-is; a PM adjusts them from the dashboard turnover detail view if the
 * crew's in-progress window genuinely needs to change.
 */
export async function acknowledgeDatesChanged(
  userId: string,
  turnoverId: string,
): Promise<void> {
  const acknowledgedAt = new Date().toISOString()
  const changes = { dates_change_acknowledged_at: acknowledgedAt }

  await writeAndQueue(userId, 'turnovers', turnoverId, 'PATCH', changes, (db) =>
    db.turnovers.update(turnoverId, changes),
  )
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
    await db.mutations.update(mutation.id!, {
      failed:            0,
      retryCount:        0,
      networkRetryCount: 0,
      // 0 is unconditionally in the past, so the row is immediately due —
      // `undefined` would leave the previous backoff window in place under
      // Dexie's update semantics.
      nextAttemptAt:     0,
      lastError:         '',
    })
  }

  void getSyncEngine(userId).processOutbox()
}

/**
 * Re-queues EVERY dead-lettered mutation on this device. Backs the crew
 * shell's failed-sync surface, which is deliberately table-agnostic — every
 * mutation type dead-letters, not just the three that once had their own
 * bespoke retry banner.
 */
export async function retryAllFailedMutations(userId: string): Promise<void> {
  const db = getDexieDb(userId)
  // orderBy('id') — NOT a bare toArray(). The drain replays in id order, and
  // SyncEngine.holdBackSuccessors() deliberately dead-letters a record's whole
  // remaining sequence so a retry re-applies it in the order the crew member
  // performed it. Clearing the flags in an unspecified order would leave that
  // sequence intact but re-queue it non-deterministically.
  const failed = (await db.mutations.where('failed').equals(1).toArray())
    .sort((a, b) => (a.id as number) - (b.id as number))

  for (const mutation of failed) {
    await db.mutations.update(mutation.id!, {
      failed:            0,
      retryCount:        0,
      networkRetryCount: 0,
      nextAttemptAt:     0,
      lastError:         '',
    })
  }

  void getSyncEngine(userId).processOutbox()
}

/**
 * Permanently drops a dead-lettered mutation the crew member has decided
 * not to retry. The only way a failed row leaves the device before
 * lib/dexie/prune.ts's retention window — deliberately an explicit user
 * action, since it discards work that never reached the server.
 */
export async function discardFailedMutation(userId: string, mutationId: number): Promise<void> {
  const db = getDexieDb(userId)
  const mutation = await db.mutations.get(mutationId)
  await db.mutations.delete(mutationId)

  // Abandoning the write hands authority back to the server — but the pull
  // that would fetch the server's value has already moved its cursor past
  // that row (see invalidateCursorsFor). Without this rewind the local cache
  // stays pinned to a value the server never accepted, forever and silently.
  if (mutation) await invalidateCursorsFor(userId, mutation.table)
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
  const startedAt = new Date().toISOString()
  const changes = { inventory_started_at: startedAt }

  await writeAndQueue(userId, 'turnovers', turnoverId, 'PATCH', changes, (db) =>
    db.turnovers.update(turnoverId, changes),
  )
}

/**
 * Marks a turnover in_progress locally and queues the mutation. SyncEngine
 * routes 'in_progress' through /api/crew/turnovers/[id]/start so started_at
 * is set authoritatively by the server, not the client clock.
 */
export async function startTurnover(userId: string, turnoverId: string): Promise<void> {
  await writeAndQueue(userId, 'turnovers', turnoverId, 'PATCH', { status: 'in_progress' }, (db) =>
    db.turnovers.update(turnoverId, { status: 'in_progress' }),
  )
}

/**
 * Marks a turnover completed locally and queues the mutation. SyncEngine
 * routes 'completed' through /api/crew/turnovers/[id]/complete so the
 * cleaning-fee posting, PM notification, and crew-duration tracking
 * pipeline fires for crew completions.
 */
export async function completeTurnover(userId: string, turnoverId: string): Promise<void> {
  await writeAndQueue(userId, 'turnovers', turnoverId, 'PATCH', { status: 'completed' }, (db) =>
    db.turnovers.update(turnoverId, { status: 'completed' }),
  )
}

/**
 * Marks a crew-assigned work order completed locally and queues the
 * mutation. SyncEngine routes this through
 * /api/crew/work-orders/[id]/complete so the PM notification, audit log,
 * and idempotent completion guard all still fire once the mutation drains
 * — including for a completion that happened while fully offline.
 */
export async function completeWorkOrder(
  userId: string,
  workOrderId: string,
  notes: string,
): Promise<void> {
  await writeAndQueue(
    userId, 'crew_work_orders', workOrderId, 'PATCH',
    { status: 'completed', notes },
    (db) => db.crew_work_orders.update(workOrderId, { status: 'completed' }),
  )
}

/** Updates an inventory item's on-hand quantity locally and queues the mutation. */
export async function updateInventoryQuantity(
  userId: string,
  itemId: string,
  currentQuantity: number,
): Promise<void> {
  const changes = { current_quantity: currentQuantity }

  await writeAndQueue(userId, 'inventory_items', itemId, 'PATCH', changes, (db) =>
    db.inventory_items.update(itemId, changes),
  )
}

// ── Turnover inventory count ──────────────────────────────────────────────
//
// A count is staged locally while the crew member walks the property, then
// submitted as ONE count when they confirm inventory complete.
//
// Two rules the previous per-item write-through violated:
//
//  - Nothing is pre-filled. The count input used to default to the item's
//    last known `current_quantity`, so a crew member had to actively
//    overwrite the previous number rather than enter a fresh one — the
//    strongest possible anchor on a measurement that drives automated
//    purchasing. An absent key now means "not counted"; 0 means "counted,
//    none on hand", and only counted items are ever submitted.
//  - The count is a COUNT, not a column write. Writing
//    `inventory_items.current_quantity` per item produced no
//    `inventory_counts` record, no previous-vs-counted diff for the PM, and
//    never fired `inventory/count-submitted` — so the crew's counts, the
//    most accurate stock data the system has, never reached the below-par
//    restock pipeline at all.

/** Counted quantities by inventory_items.id. An absent key is NOT a zero. */
export type TurnoverInventoryCounts = Record<string, number>

/** Per-turnover, not per-property: a partial count must never bleed into the
 *  next turnover at the same property. */
function turnoverCountKey(turnoverId: string): string {
  return `inventory_count:turnover:${turnoverId}`
}

export async function loadTurnoverInventoryCounts(
  userId: string,
  turnoverId: string,
): Promise<TurnoverInventoryCounts> {
  const db = getDexieDb(userId)
  const row = await db.sync_meta.get(turnoverCountKey(turnoverId))
  if (!row?.value) return {}
  try {
    const parsed: unknown = JSON.parse(row.value)
    return (parsed && typeof parsed === 'object' ? parsed : {}) as TurnoverInventoryCounts
  } catch (err) {
    console.error('[inventory count] corrupt local draft — starting fresh:', err)
    reportError(err, { site: 'lib.dexie.helpers.loadTurnoverInventoryCounts' })
    return {}
  }
}

/**
 * Persists the in-progress count so it survives navigation, a reload, or the
 * PWA being reclaimed mid-shift. The per-item write-through this replaces was
 * crudely durable for exactly this reason — dropping it without persisting
 * here would make a partial count LESS safe than before.
 */
export async function saveTurnoverInventoryCounts(
  userId: string,
  turnoverId: string,
  counts: TurnoverInventoryCounts,
): Promise<void> {
  const db = getDexieDb(userId)
  await db.sync_meta.put({ key: turnoverCountKey(turnoverId), value: JSON.stringify(counts) })
}

/**
 * Queues the staged count for submission and clears the local staging row, in
 * one transaction. The count id is client-generated and used by the route as
 * the `inventory_counts` primary key, so an outbox replay collides on the PK
 * rather than recording the same physical count twice.
 */
export async function submitTurnoverInventoryCounts(
  userId: string,
  propertyId: string,
  turnoverId: string,
  counts: TurnoverInventoryCounts,
): Promise<void> {
  const countId = crypto.randomUUID()

  await writeAndQueue(
    userId, 'inventory_counts', countId, 'PUT',
    { property_id: propertyId, counts },
    (db) => db.sync_meta.delete(turnoverCountKey(turnoverId)),
  )
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
  await writeAndQueue(userId, 'turnovers', turnoverId, 'PATCH', { completion_notes: notes }, (db) =>
    db.turnovers.update(turnoverId, { completion_notes: notes }),
  )
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
    report_id:    id,
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
  const isAvailable = params.isAvailable ? 1 : 0

  if (params.id) {
    const existingId = params.id
    await writeAndQueue(
      userId, 'crew_availability', existingId, 'PATCH',
      { is_available: isAvailable, notes: params.notes },
      (db) => db.crew_availability.update(existingId, {
        is_available: isAvailable,
        notes:        params.notes ?? '',
      }),
    )
    return
  }

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  await writeAndQueue(
    userId, 'crew_availability', id, 'PUT',
    {
      org_id:         params.orgId,
      crew_member_id: params.crewMemberId,
      available_date: params.date,
      is_available:   isAvailable,
      notes:          params.notes,
      created_at:     createdAt,
    },
    (db) => db.crew_availability.add({
      id,
      org_id:         params.orgId,
      crew_member_id: params.crewMemberId,
      available_date: params.date,
      is_available:   isAvailable,
      notes:          params.notes ?? '',
      created_at:     createdAt,
    }),
  )
}
