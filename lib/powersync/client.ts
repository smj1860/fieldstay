import { PowerSyncDatabase } from '@powersync/web'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { createClient } from '@/lib/supabase/client'
import { AppSchema } from './schema'

class SupabaseConnector {
  private supabase = createClient()

  async fetchCredentials() {
    const { data: { session } } = await this.supabase.auth.getSession()
    if (!session) return null
    return {
      endpoint: process.env.NEXT_PUBLIC_POWERSYNC_URL!,
      token:    session.access_token,
    }
  }

  async uploadData(database: AbstractPowerSyncDatabase) {
    const transaction = await database.getNextCrudTransaction()
    if (!transaction) return

    try {
      for (const op of transaction.crud) {
        if (op.table === 'checklist_instance_items' && (op.op === 'PUT' || op.op === 'PATCH')) {
          const { error } = await this.supabase
            .from('checklist_instance_items')
            .update({
              is_completed:       op.opData?.is_completed,
              completed_at:       op.opData?.completed_at ?? null,
              crew_notes:         op.opData?.crew_notes,
              photo_storage_path: op.opData?.photo_storage_path ?? null,
            })
            .eq('id', op.id)
          if (error) console.error('[PowerSync] checklist_instance_items upload failed:', error.message)
        }
        if (op.table === 'turnovers' && (op.op === 'PUT' || op.op === 'PATCH')) {
          try {
            if (op.opData?.status === 'completed') {
              // Routed through a Server Route Handler (not a direct table write) so
              // the turnover/completed pipeline (cleaning-fee posting, PM
              // notification, crew-duration tracking) fires for crew completions.
              const res = await fetch(`/api/crew/turnovers/${op.id}/complete`, { method: 'POST' })
              if (!res.ok) console.error(`[PowerSync] Failed to complete turnover ${op.id}`)
            } else if (op.opData?.status === 'in_progress') {
              // Routed through a Server Route Handler so started_at is set
              // authoritatively by the server, not the client clock.
              const res = await fetch(`/api/crew/turnovers/${op.id}/start`, { method: 'POST' })
              if (!res.ok) console.error(`[PowerSync] Failed to start turnover ${op.id}`)
            } else {
              const { error } = await this.supabase
                .from('turnovers')
                .update({ status: op.opData?.status })
                .eq('id', op.id)
              if (error) console.error('[PowerSync] turnovers upload failed:', error.message)
            }
          } catch (err) {
            console.error('[PowerSync] turnovers upload failed:', err)
          }
        }
        if (op.table === 'turnover_issue_reports' && op.op === 'PUT') {
          try {
            const res = await fetch('/api/crew/issue-reports', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                turnover_id: op.opData?.turnover_id,
                title:       op.opData?.title,
                description: op.opData?.description,
                priority:    op.opData?.priority,
              }),
            })
            if (!res.ok) console.error(`[PowerSync] Failed to submit issue report ${op.id}`)
          } catch (err) {
            console.error('[PowerSync] issue report upload failed:', err)
          }
        }
        if (op.table === 'inventory_items' && (op.op === 'PUT' || op.op === 'PATCH')) {
          const { error } = await this.supabase
            .from('inventory_items')
            .update({ current_quantity: op.opData?.current_quantity })
            .eq('id', op.id)
          if (error) console.error('[PowerSync] inventory_items upload failed:', error.message)
        }
        if (op.table === 'crew_availability' && (op.op === 'PUT' || op.op === 'PATCH')) {
          const isAvailable = op.opData?.is_available === 1
          if (op.opData?.org_id) {
            // Full INSERT — upsert on primary key to handle any duplicate
            const { error } = await this.supabase
              .from('crew_availability')
              .upsert({
                id:             op.id,
                org_id:         op.opData.org_id,
                crew_member_id: op.opData.crew_member_id,
                available_date: op.opData.available_date,
                is_available:   isAvailable,
                notes:          op.opData.notes ?? null,
                created_at:     op.opData.created_at,
              })
            if (error) console.error('[PowerSync] crew_availability upsert failed:', error.message)
          } else {
            // UPDATE of existing row — only push changed fields
            const { error } = await this.supabase
              .from('crew_availability')
              .update({
                is_available: isAvailable,
                notes:        op.opData?.notes ?? null,
              })
              .eq('id', op.id)
            if (error) console.error('[PowerSync] crew_availability upload failed:', error.message)
          }
        }
      }
    } finally {
      // CRITICAL: always complete the transaction so local SQLite
      // reactive queries stay responsive even when Supabase is unreachable.
      // Failed ops will be retried on the next uploadData call.
      await transaction.complete()
    }
  }
}

let db: PowerSyncDatabase | null = null
let dbUserId: string | null = null

export function getPowerSyncDb(userId: string): PowerSyncDatabase {
  if (!db || dbUserId !== userId) {
    if (db) {
      void db.disconnect()
      db = null
    }
    dbUserId = userId
    db = new PowerSyncDatabase({
      schema:   AppSchema,
      database: { dbFilename: `fieldstay-crew-${userId}.db` },
    })

    //  ========================================================
    // 2. MIGRATE THE CONNECTION TO SYNC STREAMS
    // ========================================================
    // Sync Streams often requires specifying the connection mode explicitly.
    // If your client library expects the new Sync Stream parameters, 
    // passing an object or ensuring parameters are explicitly structured is key.
    db.connect(new SupabaseConnector());
  }
  return db
}

export async function disconnectPowerSync(): Promise<void> {
  if (db) {
    await db.disconnect()
    db = null
    dbUserId = null
  }
}
