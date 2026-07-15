import { createClient } from '@/lib/supabase/client'
import { getDexieDb, type MutationRow } from './schema'

type DexieSupabaseClient = ReturnType<typeof createClient>

// Mirrors the upstream sync logic in lib/powersync/client.ts (SupabaseConnector.uploadData),
// replacing PowerSync's CRUD transaction queue with the local `mutations` outbox table.
export class SyncEngine {
  private supabase = createClient()
  private userId: string
  private isProcessing = false

  constructor(userId: string) {
    this.userId = userId
  }

  /**
   * Drains the local `mutations` outbox in chronological (insertion) order.
   * Each mutation is removed from the outbox only after it is successfully
   * pushed upstream — a failed mutation is left in place and retried on the
   * next call, mirroring PowerSync's per-record retry behavior. Rows already
   * marked `failed` (dead-lettered on a prior run) are excluded rather than
   * retried forever — retryFailedMutation() in helpers.ts is the only way
   * back into the queue for those.
   */
  async processOutbox(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const db = getDexieDb(this.userId)
      const pending = (await db.mutations.orderBy('id').toArray()).filter((m) => !m.failed)

      for (const mutation of pending) {
        // Auto-incrementing key — always populated once read back from the table.
        const id = mutation.id as number
        try {
          await uploadOne(this.supabase, mutation)
          await db.mutations.delete(id)
        } catch (err) {
          const newRetryCount = mutation.retryCount + 1
          console.error(
            `[SyncEngine] mutation ${id} (${mutation.table}) failed ` +
            `(attempt ${newRetryCount}):`, err
          )

          const MAX_RETRIES = 5
          if (newRetryCount >= MAX_RETRIES) {
            // Dead-letter: keep the row (marked failed) rather than deleting
            // it, so a write that never reached the server leaves a durable,
            // queryable trace instead of vanishing — callers like the crew
            // turnover page surface this via useLiveQuery and offer a retry.
            console.error(
              `[SyncEngine] mutation ${id} (${mutation.table}) exceeded ` +
              `${MAX_RETRIES} retries — marking failed. ` +
              `Payload:`, JSON.stringify({ table: mutation.table, op: mutation.op, targetId: mutation.targetId })
            )
            await db.mutations.update(id, { retryCount: newRetryCount, failed: true })
          } else {
            await db.mutations.update(id, { retryCount: newRetryCount })
            // Only block the queue on transient failures, not permanent ones.
            // If we've retried >= 3 times, skip this mutation and continue
            // draining so later mutations (which may be independent) still go through.
            if (newRetryCount >= 3) continue
            // Stop draining on first/second failure so later mutations against
            // the same record aren't applied out of order.
            break
          }
        }
      }
    } finally {
      this.isProcessing = false
    }
  }
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
  const updatePayload: MutationPayload = {
    is_completed: payload.is_completed,
    completed_at: payload.completed_at ?? null,
  }
  if ('crew_notes' in payload)           updatePayload.crew_notes = payload.crew_notes
  if ('photo_storage_path' in payload)   updatePayload.photo_storage_path = payload.photo_storage_path
  if ('completed_by_crew_id' in payload) updatePayload.completed_by_crew_id = payload.completed_by_crew_id || null

  const { data, error } = await supabase
    .from('checklist_instance_items')
    .update(updatePayload)
    .eq('id', targetId)
    .select('id')
  if (error) throw new Error(`checklist_instance_items upload failed: ${error.message}`)
  if (!data || data.length === 0) throw new Error(`checklist_instance_items upload matched zero rows for id ${targetId}`)
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
    if (!res.ok) throw new Error(`Failed to complete turnover ${targetId}`)
    return
  }
  if (payload.status === 'in_progress') {
    // Routed through a Server Route Handler so started_at is set
    // authoritatively by the server, not the client clock.
    const res = await fetch(`/api/crew/turnovers/${targetId}/start`, { method: 'POST' })
    if (!res.ok) throw new Error(`Failed to start turnover ${targetId}`)
    return
  }

  // Inventory confirmation bookkeeping (markInventoryStarted /
  // confirmInventoryComplete) — plain field updates, not a status
  // transition, so no Route Handler / side effects needed here. The
  // client-side effect that watches for "both checklist and inventory
  // confirmed" is what calls completeTurnover() (routed above) to actually
  // finish the turnover.
  const fieldUpdate: MutationPayload = {}
  if ('inventory_started_at' in payload) fieldUpdate.inventory_started_at = payload.inventory_started_at
  if ('inventory_confirmed_complete_at' in payload) fieldUpdate.inventory_confirmed_complete_at = payload.inventory_confirmed_complete_at
  if ('inventory_confirmed_by_crew_id' in payload) fieldUpdate.inventory_confirmed_by_crew_id = payload.inventory_confirmed_by_crew_id || null
  if ('completion_notes' in payload) fieldUpdate.completion_notes = payload.completion_notes
  if ('dates_change_acknowledged_at' in payload) fieldUpdate.dates_change_acknowledged_at = payload.dates_change_acknowledged_at

  if (Object.keys(fieldUpdate).length > 0) {
    const { data, error } = await supabase
      .from('turnovers')
      .update(fieldUpdate)
      .eq('id', targetId)
      .select('id')
    if (error) throw new Error(`turnovers upload failed: ${error.message}`)
    if (!data || data.length === 0) throw new Error(`turnovers upload matched zero rows for id ${targetId}`)
    return
  }

  const { data, error } = await supabase
    .from('turnovers')
    .update({ status: payload.status })
    .eq('id', targetId)
    .select('id')
  if (error) throw new Error(`turnovers upload failed: ${error.message}`)
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
  if (error) throw new Error(`checklist_instances upload failed: ${error.message}`)
  if (!data || data.length === 0) throw new Error(`checklist_instances upload matched zero rows for id ${targetId}`)
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
  if (!res.ok) throw new Error(`Failed to place work order ${targetId}`)
}

async function uploadInventoryItemCount(
  supabase: DexieSupabaseClient,
  targetId: string,
  payload: MutationPayload,
): Promise<void> {
  const { data, error } = await supabase
    .from('inventory_items')
    .update({ current_quantity: payload.current_quantity })
    .eq('id', targetId)
    .select('id')
  if (error) throw new Error(`inventory_items upload failed: ${error.message}`)
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
      throw new Error('Someone else already captured this asset type.')
    }
    throw new Error(`property_assets upload failed: ${error.message}`)
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
  if (error) throw new Error(`property_assets upload failed: ${error.message}`)
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
    if (error) throw new Error(`crew_availability upsert failed: ${error.message}`)
    return
  }

  // UPDATE of existing row — only push changed fields
  const { data, error } = await supabase
    .from('crew_availability')
    .update({
      is_available: isAvailable,
      notes:        payload.notes ?? null,
    })
    .eq('id', targetId)
    .select('id')
  if (error) throw new Error(`crew_availability upload failed: ${error.message}`)
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

/** Queues a mutation in the outbox and fires processOutbox() in the background. */
export async function enqueueMutation(
  userId: string,
  table: MutationRow['table'],
  targetId: string,
  op: MutationRow['op'],
  payload: Record<string, unknown>,
): Promise<void> {
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
