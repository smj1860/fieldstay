import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import type { DBClient }       from '@/lib/supabase/server'

/**
 * SCHEDULED: runs daily at 9:30am CT — 15 min after dailyGuestPiiRetention,
 * continuing the retention-cron stagger to avoid Supabase contention.
 *
 * Retention policy for the `notifications` table (in-app bell events —
 * append-heavy, previously grew forever):
 *  • read rows (`read_at IS NOT NULL`) older than 90 days are deleted
 *  • ALL rows (read or unread) older than 180 days are deleted
 *
 * Deletes run in bounded batches (select up to BATCH_SIZE ids, delete by id,
 * repeat) — never one unbounded DELETE — with a per-run batch ceiling so a
 * huge backlog degrades to "finish tomorrow" instead of one giant
 * transaction. Deletes are naturally idempotent, so every step is safe for
 * Inngest to replay. Only row counts are logged — never notification
 * title/subtitle content.
 */

const READ_RETENTION_DAYS = 90   // read rows older than this are purged
const MAX_RETENTION_DAYS  = 180  // all rows older than this are purged, read or not
const BATCH_SIZE          = 500
const MAX_BATCHES_PER_RUN = 20   // hard ceiling: 10k rows per policy per run

interface PurgeResult {
  deleted:   number
  exhausted: boolean  // true = no rows left past the cutoff; false = hit the batch ceiling
}

/**
 * Deletes rows past `cutoffIso` in bounded batches. `onlyRead` restricts the
 * purge to rows that have been read (`read_at IS NOT NULL`).
 */
async function purgeNotificationsBefore(
  supabase: DBClient,
  cutoffIso: string,
  onlyRead: boolean,
): Promise<PurgeResult> {
  let deleted = 0

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    let query = supabase
      .from('notifications')
      .select('id')
      .lt('created_at', cutoffIso)
    if (onlyRead) query = query.not('read_at', 'is', null)

    const { data: stale, error: selectError } = await query.limit(BATCH_SIZE)
    if (selectError) throw new Error(`notifications retention select failed: ${selectError.message}`)
    if (!stale || stale.length === 0) return { deleted, exhausted: true }

    const ids = stale.map((row: { id: string }) => row.id)
    const { error: deleteError } = await supabase
      .from('notifications')
      .delete()
      .in('id', ids)
    if (deleteError) throw new Error(`notifications retention delete failed: ${deleteError.message}`)

    deleted += ids.length
    if (ids.length < BATCH_SIZE) return { deleted, exhausted: true }
  }

  return { deleted, exhausted: false }
}

export const notificationsRetentionCron = inngest.createFunction(
  {
    id:      'cron-notifications-retention',
    name:    'Cron: Notifications Retention Purge',
    retries: 1,
  },
  { cron: '30 14 * * *' },  // 15 min after dailyGuestPiiRetention
  async ({ step, logger }) => {
    // Read rows: purged once 90 days old. Idempotent — re-running deletes
    // nothing new once the window is clear.
    const readPurge = await step.run('purge-read-notifications-90d', async () => {
      const supabase = createServiceClient({ system: 'inngest:notifications-retention' })
      const cutoff = new Date(Date.now() - READ_RETENTION_DAYS * 86_400_000).toISOString()
      return purgeNotificationsBefore(supabase, cutoff, true)
    })

    // All rows (read or unread): purged once 180 days old.
    const maxAgePurge = await step.run('purge-all-notifications-180d', async () => {
      const supabase = createServiceClient({ system: 'inngest:notifications-retention' })
      const cutoff = new Date(Date.now() - MAX_RETENTION_DAYS * 86_400_000).toISOString()
      return purgeNotificationsBefore(supabase, cutoff, false)
    })

    logger.info(
      `Notifications retention — read>90d deleted: ${readPurge.deleted}, ` +
      `any>180d deleted: ${maxAgePurge.deleted}` +
      (readPurge.exhausted && maxAgePurge.exhausted
        ? ''
        : ' (batch ceiling hit — remainder purges on the next run)')
    )

    return {
      read_deleted:    readPurge.deleted,
      max_age_deleted: maxAgePurge.deleted,
      exhausted:       readPurge.exhausted && maxAgePurge.exhausted,
    }
  }
)
