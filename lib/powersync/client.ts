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

    for (const op of transaction.crud) {
      if (op.table === 'checklist_instance_items' && op.op === 'PUT') {
        await this.supabase
          .from('checklist_instance_items')
          .update({
            is_completed:       op.opData?.is_completed,
            crew_notes:         op.opData?.crew_notes,
            photo_storage_path: op.opData?.photo_storage_path ?? null,
          })
          .eq('id', op.id)
      }
      if (op.table === 'turnovers' && op.op === 'PUT') {
        await this.supabase
          .from('turnovers')
          .update({ status: op.opData?.status })
          .eq('id', op.id)
      }
      if (op.table === 'inventory_items' && op.op === 'PUT') {
        await this.supabase
          .from('inventory_items')
          .update({ current_quantity: op.opData?.current_quantity })
          .eq('id', op.id)
      }
    }
    await transaction.complete()
  }
}

let db: PowerSyncDatabase | null = null
let dbUserId: string | null = null

export function getPowerSyncDb(userId: string): PowerSyncDatabase {
  if (!db || dbUserId !== userId) {
    if (db) {
      // Disconnect old db before creating a new one for a different user
      void db.disconnect()
      db = null
    }
    dbUserId = userId
    db = new PowerSyncDatabase({
      schema:   AppSchema,
      database: { dbFilename: `fieldstay-crew-${userId}.db` },
    })
    db.connect(new SupabaseConnector())
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
