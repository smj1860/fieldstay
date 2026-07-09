import { createClient } from '@/lib/supabase/client'
import { getDexieDb, type MutationRow } from './schema'

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
          await this.uploadOne(mutation)
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

  private async uploadOne(mutation: MutationRow): Promise<void> {
    const { table, targetId, op, payload } = mutation

    if (table === 'checklist_instance_items' && (op === 'PUT' || op === 'PATCH')) {
      // Only send fields updateChecklistItem() actually included in the
      // local mutation — `payload.crew_notes ?? null`-style unconditional
      // sends previously clobbered photo_storage_path (and would have done
      // the same to crew_notes/completed_by_crew_id) to null/empty on every
      // plain checkbox toggle, even when that toggle never touched those
      // fields locally. This is what the doc comment on updateChecklistItem
      // has always promised, but the upload path didn't actually honor it.
      const updatePayload: Record<string, unknown> = {
        is_completed: payload.is_completed,
        completed_at: payload.completed_at ?? null,
      }
      if ('crew_notes' in payload)           updatePayload.crew_notes = payload.crew_notes
      if ('photo_storage_path' in payload)   updatePayload.photo_storage_path = payload.photo_storage_path
      if ('completed_by_crew_id' in payload) updatePayload.completed_by_crew_id = payload.completed_by_crew_id || null

      const { error } = await this.supabase
        .from('checklist_instance_items')
        .update(updatePayload)
        .eq('id', targetId)
      if (error) throw new Error(`checklist_instance_items upload failed: ${error.message}`)
      return
    }

    if (table === 'turnovers' && (op === 'PUT' || op === 'PATCH')) {
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
      // confirmed" is what calls completeTurnover() (routed above) to
      // actually finish the turnover.
      const fieldUpdate: Record<string, unknown> = {}
      if ('inventory_started_at' in payload) fieldUpdate.inventory_started_at = payload.inventory_started_at
      if ('inventory_confirmed_complete_at' in payload) fieldUpdate.inventory_confirmed_complete_at = payload.inventory_confirmed_complete_at
      if ('inventory_confirmed_by_crew_id' in payload) fieldUpdate.inventory_confirmed_by_crew_id = payload.inventory_confirmed_by_crew_id || null

      if (Object.keys(fieldUpdate).length > 0) {
        const { error } = await this.supabase
          .from('turnovers')
          .update(fieldUpdate)
          .eq('id', targetId)
        if (error) throw new Error(`turnovers upload failed: ${error.message}`)
        return
      }

      const { error } = await this.supabase
        .from('turnovers')
        .update({ status: payload.status })
        .eq('id', targetId)
      if (error) throw new Error(`turnovers upload failed: ${error.message}`)
      return
    }

    if (table === 'checklist_instances' && (op === 'PUT' || op === 'PATCH')) {
      // "Confirm Checklist Complete" (or un-confirm) — a deliberate human
      // assertion on the shared instance row, not derived from item state.
      const updatePayload: Record<string, unknown> = {}
      if ('completed_at' in payload)         updatePayload.completed_at = payload.completed_at
      if ('completed_by_crew_id' in payload) updatePayload.completed_by_crew_id = payload.completed_by_crew_id || null

      const { error } = await this.supabase
        .from('checklist_instances')
        .update(updatePayload)
        .eq('id', targetId)
      if (error) throw new Error(`checklist_instances upload failed: ${error.message}`)
      return
    }

    if (table === 'turnover_issue_reports' && op === 'PUT') {
      const res = await fetch('/api/crew/issue-reports', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turnover_id: payload.turnover_id,
          title:       payload.title,
          description: payload.description,
          priority:    payload.priority,
        }),
      })
      if (!res.ok) throw new Error(`Failed to submit issue report ${targetId}`)
      return
    }

    if (table === 'inventory_items' && (op === 'PUT' || op === 'PATCH')) {
      const { error } = await this.supabase
        .from('inventory_items')
        .update({ current_quantity: payload.current_quantity })
        .eq('id', targetId)
      if (error) throw new Error(`inventory_items upload failed: ${error.message}`)
      return
    }

    if (table === 'crew_availability' && (op === 'PUT' || op === 'PATCH')) {
      const isAvailable = payload.is_available === 1
      if (payload.org_id) {
        // Full INSERT — upsert on primary key to handle any duplicate
        const { error } = await this.supabase
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
      } else {
        // UPDATE of existing row — only push changed fields
        const { error } = await this.supabase
          .from('crew_availability')
          .update({
            is_available: isAvailable,
            notes:        payload.notes ?? null,
          })
          .eq('id', targetId)
        if (error) throw new Error(`crew_availability upload failed: ${error.message}`)
      }
      return
    }
  }
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
