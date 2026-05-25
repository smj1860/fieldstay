import { PowerSyncDatabase } from '@powersync/web'
import { createClient } from '@/lib/supabase/client'
import { AppSchema } from './schema'

class SupabaseConnector {
  private supabase = createClient()

  async fetchCredentials() {
    const { data: { session } } = await this.supabase.auth.getSession()
    if (!session) throw new Error('No session')
    return {
      endpoint: process.env.NEXT_PUBLIC_POWERSYNC_URL!,
      token:    session.access_token,
    }
  }

  async uploadData(database: PowerSyncDatabase) {
    const transaction = await database.getNextCrudTransaction()
    if (!transaction) return

    for (const op of transaction.crud) {
      if (op.table === 'checklist_instance_items' && op.op === 'PUT') {
        await this.supabase
          .from('checklist_instance_items')
          .update({
            is_completed: op.opData?.is_completed,
            crew_notes:   op.opData?.crew_notes,
          })
          .eq('id', op.id)
      }
      if (op.table === 'turnovers' && op.op === 'PUT') {
        await this.supabase
          .from('turnovers')
          .update({ status: op.opData?.status })
          .eq('id', op.id)
      }
    }
    await transaction.complete()
  }
}

let db: PowerSyncDatabase | null = null

export function getPowerSyncDb(): PowerSyncDatabase {
  if (!db) {
    db = new PowerSyncDatabase({
      schema:   AppSchema,
      database: { dbFilename: 'fieldstay-crew.db' },
    })
    db.connect(new SupabaseConnector())
  }
  return db
}
