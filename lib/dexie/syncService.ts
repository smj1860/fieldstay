import { createClient } from '@/lib/supabase/client'
import { getDexieDb, isDexieShutdown, type FieldStayDexie, type MutationRow } from './schema'
import {
  isOnline,
  withTabLock,
  classifyUploadFailure,
  UploadDataError,
  UploadHttpError,
} from './net'

import { reportError } from '@/lib/observability/report-error'
type DexieSupabaseClient = ReturnType<typeof createClient>

const MAX_RETRIES = 5

// Retry backoff: 5 s base doubling per retry, capped at 5 min, each delay
// scaled by a uniform 0.5–1.5× jitter factor so a fleet of crew devices
// coming back from the same outage doesn't retry in lockstep.
const BASE_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS  = 300_000

/**
 * Computes the epoch-ms timestamp before which a failed mutation must not be
 * re-pushed. `retryCount` is the ALREADY-incremented count for the failure
 * being handled — the `- 1` keeps the first retry at the 5 s base (growth:
 * 5 s → 10 s → 20 s … capped at 5 min, each scaled 0.5–1.5×).
 */
export function computeNextAttemptAt(retryCount: number, now: number): number {
  const baseDelay = Math.min(2 ** (retryCount - 1) * BASE_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS)
  // eslint-disable-next-line no-restricted-properties -- retry backoff jitter to spread outbox retry storms after an outage, not id/token generation
  const jitter = Math.random() // NOSONAR -- timing jitter only, not security-sensitive (see eslint-disable justification above)
  return now + baseDelay * (0.5 + jitter)
}

// Drains the local `mutations` outbox to Supabase. This is the only path by
// which a crew-side write reaches the server — see enqueueMutation().
export class SyncEngine {
  private supabase = createClient()
  private userId: string
  // Per-tab reentrancy guard. NOT sufficient on its own: the outbox lives in
  // a shared IndexedDB, so two tabs each pass their own guard — withTabLock()
  // in processOutbox() is what actually serializes the drain across tabs.
  private isProcessing = false
  private disposed = false
  // Single pending wake-up for a drain that stopped on a not-yet-due
  // mutation. One handle only — scheduleRetry() clears any previous timer
  // before setting a new one; the existing `online` listener and
  // enqueueMutation()'s fire-and-forget drains remain additional entry
  // points, so an overwritten (later) wake-up self-corrects on the next
  // drain, which stops on the still-not-due head and reschedules.
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(userId: string) {
    this.userId = userId
  }

  private scheduleRetry(nextAttemptAt: number): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.disposed) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.disposed) return
      void this.processOutbox()
    }, Math.max(0, nextAttemptAt - Date.now()))
  }

  /**
   * Permanently stops this engine. Called on logout, BEFORE the IndexedDB
   * database is deleted: a pending retry timer that fires afterwards would
   * call getDexieDb() and re-create the database that was just deleted,
   * leaving an empty `fieldstay-crew-{userId}` behind on a device the user
   * has signed out of.
   */
  dispose(): void {
    this.disposed = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /**
   * Drains the local `mutations` outbox in chronological (insertion) order.
   * Each mutation is removed from the outbox only after it is successfully
   * pushed upstream — a failed mutation is left in place and retried on the
   * next call, so a transient failure retries per record rather than blocking
   * the whole outbox. Rows already
   * marked `failed` (dead-lettered on a prior run) are excluded rather than
   * retried forever — retryFailedMutation() in helpers.ts is the only way
   * back into the queue for those.
   *
   * Failed (non-dead-lettered) mutations back off exponentially via
   * nextAttemptAt: a mutation whose backoff window hasn't elapsed stops the
   * drain entirely — never skip-and-continue, because later mutations against
   * the same record must not jump ahead (the same ordering rule as the
   * stop-on-first-error semantics below; "not due yet" is just an additional
   * stop reason). A stopped drain schedules a one-shot timer to resume at
   * nextAttemptAt.
   *
   * Failure accounting (see lib/dexie/net.ts's classifyUploadFailure):
   *  - `network`  — never reached the server. Costs NO retry budget and can
   *                 never dead-letter; retries forever on the same capped
   *                 backoff. This is the offline-crew case the whole PWA
   *                 exists for.
   *  - `terminal` — the server rejected it in a way replay cannot fix (4xx
   *                 validation, constraint violation, RLS denial). Dead-letters
   *                 immediately rather than burning five pointless retries.
   *  - `transient` — may succeed later. Costs a retry; dead-letters at
   *                 MAX_RETRIES.
   *
   * The drain is additionally a no-op while offline: an attempt that cannot
   * physically be made is not a failed attempt.
   */
  /**
   * True when this engine must not touch storage at all: it was disposed, or
   * this user signed out and their local database was deleted. The second
   * check is NOT redundant with `disposed` — disposeSyncEngine() drops the
   * module-level engine, so any later getSyncEngine(userId) hands out a
   * BRAND-NEW, undisposed engine. Without the shutdown latch, an `online`
   * event or the 30 s interval firing after logout would drain through that
   * fresh engine and re-create the database that was just wiped.
   */
  private stopped(): boolean {
    return this.disposed || isDexieShutdown(this.userId)
  }

  async processOutbox(): Promise<void> {
    if (this.isProcessing || this.stopped()) return
    this.isProcessing = true
    try {
      await withTabLock(`fieldstay-crew-outbox-${this.userId}`, () => this.drain())
    } finally {
      this.isProcessing = false
    }
  }

  private async drain(): Promise<void> {
    // Offline: do not attempt, and above all do not charge a retry for an
    // attempt that never left the device.
    if (!isOnline() || this.stopped()) return

    const db = getDexieDb(this.userId)
    const pending = (await db.mutations.orderBy('id').toArray()).filter((m) => !m.failed)

    for (const mutation of pending) {
      // Auto-incrementing key — always populated once read back from the table.
      const id = mutation.id as number

      // Backoff gate: a mutation still inside its retry window stops the
      // drain entirely (never skip-and-continue — later mutations against
      // the same record must not jump ahead). Resume when it comes due.
      if (mutation.nextAttemptAt !== undefined && mutation.nextAttemptAt > Date.now()) {
        this.scheduleRetry(mutation.nextAttemptAt)
        return
      }

      // Connectivity can drop mid-drain — re-check before every push so the
      // remaining mutations aren't charged retries for a dead connection.
      // Also re-checked here for the in-flight case: logout can land while
      // this loop is awaiting an upload, and the remaining iterations must
      // not write to (or re-open) a database that no longer exists.
      if (!isOnline() || this.stopped()) return

      if (await this.pushOne(db, mutation, id) === 'stop') return
    }
  }

  /**
   * Pushes one mutation and records the outcome. Returns 'stop' when the drain
   * must not continue — either to preserve per-record ordering, or because
   * this user signed out mid-push and their local database is gone.
   */
  private async pushOne(db: FieldStayDexie, mutation: MutationRow, id: number): Promise<'continue' | 'stop'> {
    try {
      await uploadOne(this.supabase, mutation)
      // Signing out while this push was in flight deletes the outbox
      // underneath us. Bail before touching storage: bookkeeping for a
      // signed-out user has nothing to write to, and going ahead would ask
      // getDexieDb() for a database that no longer exists.
      if (this.stopped()) return 'stop'
      // Successful push clears the whole row — nextAttemptAt with it.
      await db.mutations.delete(id)
      return 'continue'
    } catch (err) {
      if (this.stopped()) return 'stop'
      return await this.handleFailure(mutation, id, err) ? 'stop' : 'continue'
    }
  }

  /**
   * Records one push failure. Returns true when the drain must stop (so
   * later mutations against the same record can't jump ahead of this one),
   * false when the mutation is finished with — dead-lettered — and the
   * drain may continue with the rest of the queue.
   */
  private async handleFailure(mutation: MutationRow, id: number, err: unknown): Promise<boolean> {
    const db = getDexieDb(this.userId)
    const kind = classifyUploadFailure(err)

    if (kind === 'network') {
      // Never reached the server: no retry consumed, no dead-lettering, ever.
      // A separate counter drives the backoff curve so repeated transport
      // failures still back off instead of hammering a dead connection.
      const level = (mutation.networkRetryCount ?? 0) + 1
      const nextAttemptAt = computeNextAttemptAt(level, Date.now())
      console.warn(
        `[SyncEngine] mutation ${id} (${mutation.table}) could not reach the ` +
        `server (transport attempt ${level}) — retrying, retry budget untouched`
      )
      await db.mutations.update(id, { networkRetryCount: level, nextAttemptAt })
      this.scheduleRetry(nextAttemptAt)
      return true
    }

    const newRetryCount = mutation.retryCount + 1
    console.error(
      `[SyncEngine] mutation ${id} (${mutation.table}) failed ` +
      `(attempt ${newRetryCount}, ${kind}):`, err
    )
    reportError(err, { site: 'lib.dexie.syncService.SyncEngine' })

    if (kind === 'terminal' || newRetryCount >= MAX_RETRIES) {
      // Dead-letter: keep the row (marked failed) rather than deleting
      // it, so a write that never reached the server leaves a durable,
      // queryable trace instead of vanishing — the crew shell's failed-sync
      // surface reads these via useLiveQuery and offers a retry.
      const reason = kind === 'terminal'
        ? 'permanently rejected'
        : `exceeded ${MAX_RETRIES} retries`
      console.error(
        `[SyncEngine] mutation ${id} (${mutation.table}) ${reason}` +
        ` — marking failed. Payload:`,
        JSON.stringify({ table: mutation.table, op: mutation.op, targetId: mutation.targetId })
      )
      await db.mutations.update(id, {
        retryCount: newRetryCount,
        failed: true,
        lastError: describeFailure(err),
      })
      // A mutation that will never succeed must not block every later write
      // against other records — it is finished, so the drain continues.
      return false
    }

    const nextAttemptAt = computeNextAttemptAt(newRetryCount, Date.now())
    await db.mutations.update(id, { retryCount: newRetryCount, nextAttemptAt })
    // Stop draining so later mutations against the same record aren't applied
    // out of order; wake up again when the backoff window elapses.
    this.scheduleRetry(nextAttemptAt)
    return true
  }
}

/**
 * Short, user-safe reason string stored on a dead-lettered mutation so the
 * failed-sync UI can say more than "didn't sync". Never includes the
 * payload — crew notes, quantities, and completion data are exactly the
 * kind of content that must not be duplicated into a diagnostics field.
 */
function describeFailure(err: unknown): string {
  if (err instanceof UploadHttpError) return `Server rejected the request (${err.status})`
  if (err instanceof UploadDataError) return err.code ? `Database rejected the change (${err.code})` : 'Database rejected the change'
  if (err instanceof Error && err.message) return err.message.slice(0, 200)
  return 'Unknown error'
}

type MutationPayload = Record<string, unknown>

// Every handler shares this signature so uploadOne() can dispatch through a
// lookup table instead of a long if/else chain — one handler per (table, op)
// pair matching lib/dexie/schema.ts's MutationTable union.
type UploadHandler = (
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
) => Promise<void>

/**
 * Every field on every table-update payload below MUST be gated on
 * `'field' in payload`. A `payload.x ?? null` fallback looks harmless but
 * writes an explicit NULL whenever the mutation simply didn't carry that
 * field — which is how photo-sync's `{ photo_storage_path }`-only PATCH
 * used to NULL `completed_at` on an item that was still `is_completed =
 * true`, destroying the timestamp that checklist duration tracking and
 * assignment_outcomes depend on. Enforced by
 * unit/guardrails/upload-payload-null-fields.test.ts.
 */
async function uploadChecklistInstanceItem(
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  // Only send fields updateChecklistItem() actually included in the local
  // mutation — `payload.crew_notes ?? null`-style unconditional sends
  // previously clobbered photo_storage_path (and would have done the same
  // to crew_notes/completed_by_crew_id) to null/empty on every plain
  // checkbox toggle, even when that toggle never touched those fields
  // locally. This is what the doc comment on updateChecklistItem has always
  // promised, but the upload path didn't actually honor it.
  const updatePayload: MutationPayload = {}
  if ('is_completed' in payload)         updatePayload.is_completed = payload.is_completed
  if ('completed_at' in payload)         updatePayload.completed_at = payload.completed_at
  if ('crew_notes' in payload)           updatePayload.crew_notes = payload.crew_notes
  if ('photo_storage_path' in payload)   updatePayload.photo_storage_path = payload.photo_storage_path
  if ('completed_by_crew_id' in payload) updatePayload.completed_by_crew_id = payload.completed_by_crew_id || null

  if (Object.keys(updatePayload).length === 0) return

  const { data, error } = await supabase
    .from('checklist_instance_items')
    .update(updatePayload)
    .eq('id', targetId)
    .select('id')
  if (error) throw new UploadDataError(`checklist_instance_items upload failed: ${error.message}`, error.code)
  if (!data || data.length === 0) throw new Error(`checklist_instance_items upload matched zero rows for id ${targetId}`)
}

/**
 * Inventory confirmation bookkeeping (markInventoryStarted /
 * confirmInventoryComplete) plus the acknowledge/notes fields — plain field
 * updates, not a status transition, so no Route Handler / side effects are
 * needed for them. The client-side effect that watches for "both checklist
 * and inventory confirmed" is what calls completeTurnover() (routed through
 * the complete handler) to actually finish the turnover.
 */
function turnoverFieldUpdate(payload: MutationPayload): MutationPayload {
  const fieldUpdate: MutationPayload = {}
  if ('inventory_started_at' in payload) fieldUpdate.inventory_started_at = payload.inventory_started_at
  if ('inventory_confirmed_complete_at' in payload) fieldUpdate.inventory_confirmed_complete_at = payload.inventory_confirmed_complete_at
  if ('inventory_confirmed_by_crew_id' in payload) fieldUpdate.inventory_confirmed_by_crew_id = payload.inventory_confirmed_by_crew_id || null
  if ('completion_notes' in payload) fieldUpdate.completion_notes = payload.completion_notes
  if ('dates_change_acknowledged_at' in payload) fieldUpdate.dates_change_acknowledged_at = payload.dates_change_acknowledged_at
  return fieldUpdate
}

async function uploadTurnoverChange(
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  if (payload.status === 'completed') {
    // Routed through a Server Route Handler (not a direct table write) so
    // the turnover/completed pipeline (cleaning-fee posting, PM
    // notification, crew-duration tracking) fires for crew completions.
    const res = await fetch(`/api/crew/turnovers/${targetId}/complete`, { method: 'POST' })
    if (!res.ok) throw new UploadHttpError(`Failed to complete turnover ${targetId}`, res.status)
    return
  }
  if (payload.status === 'in_progress') {
    // Routed through a Server Route Handler so started_at is set
    // authoritatively by the server, not the client clock.
    const res = await fetch(`/api/crew/turnovers/${targetId}/start`, { method: 'POST' })
    if (!res.ok) throw new UploadHttpError(`Failed to start turnover ${targetId}`, res.status)
    return
  }

  const fieldUpdate = turnoverFieldUpdate(payload)
  if (Object.keys(fieldUpdate).length > 0) {
    const { data, error } = await supabase
      .from('turnovers')
      .update(fieldUpdate)
      .eq('id', targetId)
      .select('id')
    if (error) throw new UploadDataError(`turnovers upload failed: ${error.message}`, error.code)
    if (!data || data.length === 0) throw new Error(`turnovers upload matched zero rows for id ${targetId}`)
    return
  }

  // Reached only for a status transition other than the two routed above.
  // Guarded like every other field: a turnovers PATCH carrying neither a
  // status nor any known field would otherwise issue an empty UPDATE that
  // matches the row and "succeeds", silently discarding the mutation.
  if (!('status' in payload)) {
    throw new UploadDataError(`turnovers upload had no recognized fields for id ${targetId}`, 'NO_FIELDS')
  }
  const { data, error } = await supabase
    .from('turnovers')
    .update({ status: payload.status })
    .eq('id', targetId)
    .select('id')
  if (error) throw new UploadDataError(`turnovers upload failed: ${error.message}`, error.code)
  if (!data || data.length === 0) throw new Error(`turnovers upload matched zero rows for id ${targetId}`)
}

async function uploadChecklistInstanceConfirmation(
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  // "Confirm Checklist Complete" (or un-confirm) — a deliberate human
  // assertion on the shared instance row, not derived from item state.
  // section_photo_path added here — previously photo-sync.ts uploaded the
  // file to Storage successfully but never pushed the resulting path
  // upstream, so it never reached the PM dashboard and was lost entirely if
  // the local Dexie row was ever cleared.
  const updatePayload: MutationPayload = {}
  if ('completed_at' in payload)         updatePayload.completed_at = payload.completed_at
  if ('completed_by_crew_id' in payload) updatePayload.completed_by_crew_id = payload.completed_by_crew_id || null
  if ('section_photo_path' in payload)   updatePayload.section_photo_path = payload.section_photo_path

  const { data, error } = await supabase
    .from('checklist_instances')
    .update(updatePayload)
    .eq('id', targetId)
    .select('id')
  if (error) throw new UploadDataError(`checklist_instances upload failed: ${error.message}`, error.code)
  if (!data || data.length === 0) throw new Error(`checklist_instances upload matched zero rows for id ${targetId}`)
}

async function uploadCrewWorkOrderChange(
  _supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  if (payload.status !== 'completed') {
    throw new Error(`uploadCrewWorkOrderChange: unhandled status "${payload.status}"`)
  }
  // Routed through the existing Route Handler, not a direct table write —
  // crew has no RLS UPDATE on work_orders by design (the route verifies
  // assigned_crew_member_id explicitly via service role instead), and the
  // route already fires the PM notification, audit log, and idempotent
  // completion guard. Do not duplicate any of that logic here.
  const res = await fetch(`/api/crew/work-orders/${targetId}/complete`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ notes: typeof payload.notes === 'string' ? payload.notes : '' }),
  })
  if (!res.ok) throw new UploadHttpError(`Failed to complete work order ${targetId}`, res.status)
}

async function uploadWorkOrderReport(
  _supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  const res = await fetch('/api/crew/work-order-reports', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      report_id:    payload.report_id ?? targetId,
      property_id:  payload.property_id,
      asset_id:     payload.asset_id,
      title:        payload.title,
      is_emergency: payload.is_emergency,
    }),
  })
  if (!res.ok) throw new UploadHttpError(`Failed to place work order ${targetId}`, res.status)
}

/**
 * Crew inventory count submitted for PM review. Routed through the Route
 * Handler (not a direct table write) because a draft is a two-table insert
 * plus a previous-quantity diff the client can't compute authoritatively.
 * `targetId` is a client-generated draft id: the route uses it as the row's
 * primary key, so an outbox replay after a connectivity blip collides
 * harmlessly instead of creating a second draft.
 */
async function uploadInventoryCountDraft(
  _supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  const res = await fetch('/api/crew/inventory-count', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      draftId:       targetId,
      propertyId:    payload.property_id,
      counts:        payload.counts,
      notes:         payload.notes,
      itemNotes:     payload.item_notes,
      submitAsDraft: true,
    }),
  })
  if (!res.ok) throw new UploadHttpError(`Failed to submit inventory count ${targetId}`, res.status)
}

async function uploadInventoryItemCount(
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  if (!('current_quantity' in payload)) {
    throw new UploadDataError(`inventory_items upload had no quantity for id ${targetId}`, 'NO_FIELDS')
  }
  const { data, error } = await supabase
    .from('inventory_items')
    .update({ current_quantity: payload.current_quantity })
    .eq('id', targetId)
    .select('id')
  if (error) throw new UploadDataError(`inventory_items upload failed: ${error.message}`, error.code)
  if (!data || data.length === 0) throw new Error(`inventory_items upload matched zero rows for id ${targetId}`)
}

async function uploadPropertyAssetInsert(
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  const { error } = await supabase
    .from('property_assets')
    .upsert({
      id:                  targetId,
      org_id:              payload.org_id,
      property_id:         payload.property_id,
      name:                payload.name,
      asset_type:          payload.asset_type,
      make:                payload.make,
      model:               payload.model,
      photo_url:           payload.photo_url,
      is_na:               payload.is_na,
      scan_status:         payload.scan_status,
      macrs_class:         '5_year',
      depreciation_method: 'macrs',
      salvage_value:       0,
    })
  if (error) {
    // 23505 = unique_violation on property_assets_property_active_type_idx —
    // another crew member captured this same asset type first. The local
    // optimistic row already written to Dexie is harmless debris (a
    // different id than the winning row) rather than something we can
    // usefully reconcile from here, so we just dead-letter it below like any
    // other permanently-failing mutation.
    if (error.code === '23505') {
      throw new UploadDataError('Someone else already captured this asset type.', error.code)
    }
    throw new UploadDataError(`property_assets upload failed: ${error.message}`, error.code)
  }
}

async function uploadPropertyAssetPhotoUpdate(
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  const updatePayload: MutationPayload = {}
  if ('photo_url' in payload) updatePayload.photo_url = payload.photo_url

  const { data, error } = await supabase
    .from('property_assets')
    .update(updatePayload)
    .eq('id', targetId)
    .select('id')
  if (error) throw new UploadDataError(`property_assets upload failed: ${error.message}`, error.code)
  if (!data || data.length === 0) throw new Error(`property_assets upload matched zero rows for id ${targetId}`)

  // Fired only once photo_url has actually landed server-side — the scan
  // route re-derives the expected storage path from the asset's own
  // (already-org-verified) photo_url and rejects a mismatch, so this can't
  // fire any earlier than this point.
  if (payload.scanRequest) {
    const { storagePath, mediaType } = payload.scanRequest as { storagePath: string; mediaType: string }
    fetch('/api/assets/request-scan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_id: targetId, storage_path: storagePath, media_type: mediaType }),
    }).catch((err) => console.error('[SyncEngine] scan request failed:', err))
  }
}

async function uploadCrewAvailability(
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  const isAvailable = payload.is_available === 1
  if (payload.org_id) {
    // Full INSERT — upsert on primary key to handle any duplicate
    const { error } = await supabase
      .from('crew_availability')
      .upsert({
        id:             targetId,
        org_id:         payload.org_id,
        crew_member_id: payload.crew_member_id,
        available_date: payload.available_date,
        is_available:   isAvailable,
        notes:          payload.notes ?? null,
        created_at:     payload.created_at,
      })
    if (error) throw new UploadDataError(`crew_availability upsert failed: ${error.message}`, error.code)
    return
  }

  // UPDATE of existing row — only push fields the mutation actually carried.
  // Never `payload.x ?? null`: a mutation that omitted a field must leave it
  // alone, not NULL it (see the doc comment on uploadChecklistInstanceItem).
  const fieldUpdate: MutationPayload = {}
  if ('is_available' in payload) fieldUpdate.is_available = isAvailable
  if ('notes' in payload)        fieldUpdate.notes = payload.notes ?? null
  if (Object.keys(fieldUpdate).length === 0) return

  const { data, error } = await supabase
    .from('crew_availability')
    .update(fieldUpdate)
    .eq('id', targetId)
    .select('id')
  if (error) throw new UploadDataError(`crew_availability upload failed: ${error.message}`, error.code)
  if (!data || data.length === 0) throw new Error(`crew_availability upload matched zero rows for id ${targetId}`)
}

// Keyed by `${table}:${op}` — every value in lib/dexie/schema.ts's
// MutationTable union must have a matching entry here (for every op it's
// actually enqueued with), or an unhandled table silently vanishes from the
// outbox instead of reaching Supabase.
const UPLOAD_HANDLERS: Record<string, UploadHandler> = {
  'checklist_instance_items:PUT':   uploadChecklistInstanceItem,
  'checklist_instance_items:PATCH': uploadChecklistInstanceItem,
  'turnovers:PUT':                  uploadTurnoverChange,
  'turnovers:PATCH':                uploadTurnoverChange,
  'checklist_instances:PUT':        uploadChecklistInstanceConfirmation,
  'checklist_instances:PATCH':      uploadChecklistInstanceConfirmation,
  'work_order_reports:PUT':         uploadWorkOrderReport,
  'inventory_items:PUT':            uploadInventoryItemCount,
  'inventory_items:PATCH':          uploadInventoryItemCount,
  'property_assets:PUT':            uploadPropertyAssetInsert,
  'property_assets:PATCH':          uploadPropertyAssetPhotoUpdate,
  'crew_availability:PUT':          uploadCrewAvailability,
  'crew_availability:PATCH':        uploadCrewAvailability,
  'crew_work_orders:PATCH':         uploadCrewWorkOrderChange,
  'inventory_count_drafts:PUT':     uploadInventoryCountDraft,
}

async function uploadOne(supabase: DexieSupabaseClient, mutation: MutationRow): Promise<void> {
  const { table, targetId, op, payload } = mutation

  const handler = UPLOAD_HANDLERS[`${table}:${op}`]
  if (!handler) {
    // No branch above matched this (table, op) combination — fail loudly
    // instead of letting processOutbox() treat this as a successful sync
    // and silently delete the mutation from the outbox without it ever
    // reaching Supabase.
    throw new Error(`[SyncEngine] no upload handler for mutation: table="${table}" op="${op}" targetId="${targetId}"`)
  }

  await handler(supabase, targetId, payload)
}

let engine: SyncEngine | null = null
let engineUserId: string | null = null

export function getSyncEngine(userId: string): SyncEngine {
  if (!engine || engineUserId !== userId) {
    engineUserId = userId
    engine = new SyncEngine(userId)
  }
  return engine
}

/**
 * Tears down the module-level engine. Call on logout BEFORE deleting the
 * IndexedDB database: a still-armed retry timer would otherwise fire after
 * the delete, call getDexieDb(), and re-create the database it just wiped.
 */
export function disposeSyncEngine(): void {
  engine?.dispose()
  engine = null
  engineUserId = null
}

/** Queues a mutation in the outbox and fires processOutbox() in the background. */
export async function enqueueMutation(
  userId: string,
  table: MutationRow['table'],
  targetId: string,
  op: MutationRow['op'],
  payload: Record<string, unknown>,
): Promise<void> {
  // Signed out: there is no longer a local database for this user, and
  // queueing here would re-create one holding a signed-out user's work.
  if (isDexieShutdown(userId)) return

  const db = getDexieDb(userId)
  await db.mutations.add({
    table,
    targetId,
    op,
    payload,
    createdAt:  new Date().toISOString(),
    retryCount: 0,
  })

  void getSyncEngine(userId).processOutbox()
}
