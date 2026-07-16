import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'

/**
 * SCHEDULED: 12pm UTC daily (7am CT) — ahead of the 8am CT cron batch
 * (asset-health, maintenance-schedules, work-order-ops all run at 13:00 UTC).
 *
 * Rolls up two categories that fire too often to notify on individually:
 *   - Work orders created in the last 24h, per org
 *   - RepuGuard review drafts generated in the last 24h, per org
 * (repuguard-batch-generate.ts can run many times a day — once per synced
 * review or per manual "Generate drafts" click — so per-run notifications
 * would spam the bell. This rolls them into one notification per org per day.)
 *
 * dedupe_key protects against a retried/duplicate cron run producing two
 * rows for the same org+day+category.
 */
export const notificationDigest = inngest.createFunction(
  { id: 'cron-notification-digest', name: 'Cron: Daily Notification Digest', retries: 2 },
  { cron: '0 12 * * *' },
  async ({ step, logger }) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const today = new Date().toISOString().split('T')[0]

    const woCreatedByOrg = await step.run('count-work-orders-created', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('work_orders')
        .select('org_id')
        .gte('created_at', since)

      if (error) throw new Error(`Failed to count work orders created: ${error.message}`)

      const counts = new Map<string, number>()
      for (const row of data ?? []) {
        counts.set(row.org_id, (counts.get(row.org_id) ?? 0) + 1)
      }
      return Array.from(counts.entries())
    })

    const repuguardByOrg = await step.run('count-repuguard-drafts', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('review_responses')
        .select('org_id')
        .gte('generated_at', since)

      if (error) throw new Error(`Failed to count RepuGuard drafts: ${error.message}`)

      const counts = new Map<string, number>()
      for (const row of data ?? []) {
        counts.set(row.org_id, (counts.get(row.org_id) ?? 0) + 1)
      }
      return Array.from(counts.entries())
    })

    let created = 0

    await step.run('write-work-order-digest', async () => {
      const supabase = createServiceClient()
      for (const [orgId, count] of woCreatedByOrg) {
        if (count === 0) continue
        await createPmNotification(supabase, {
          orgId,
          type:      'work_order_created_digest',
          title:     `${count} work order${count !== 1 ? 's' : ''} created today`,
          subtitle:  'Tap to view all work orders',
          href:      '/maintenance',
          severity:  'blue',
          dedupeKey: `wo-created-digest-${orgId}-${today}`,
        })
        created++
      }
    })

    await step.run('write-repuguard-digest', async () => {
      const supabase = createServiceClient()
      for (const [orgId, count] of repuguardByOrg) {
        if (count === 0) continue
        await createPmNotification(supabase, {
          orgId,
          type:      'repuguard_digest',
          title:     `${count} review draft${count !== 1 ? 's' : ''} ready`,
          subtitle:  'RepuGuard generated new drafts for your review',
          href:      '/reviews',
          severity:  'blue',
          dedupeKey: `repuguard-digest-${orgId}-${today}`,
        })
        created++
      }
    })

    logger.info(`Notification digest: ${created} notification(s) written`)
    return { notifications_created: created }
  }
)
