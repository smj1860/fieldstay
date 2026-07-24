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
 * The work-order count excludes anything still unassigned (no vendor_id,
 * status pending/quote_requested) — cron-daily-wrapup's unassigned-WO
 * section (6pm CT) names those individually, so a WO created this morning
 * would otherwise get surfaced twice: once as an anonymous count here, once
 * by name that evening. This digest is left covering only WOs that already
 * have a vendor / are past that stage, so the two notifications complement
 * rather than duplicate each other.
 *
 * dedupe_key protects against a retried/duplicate cron run producing two
 * rows for the same org+day+category.
 */
export const notificationDigest = inngest.createFunction(
  { id: 'cron-notification-digest', name: 'Cron: Daily Notification Digest', retries: 2 },
  { cron: '0 12 * * *' },
  async ({ step, logger }) => {
    // Captured in its own memoized step so `since`/`today` (baked into each
    // notification's dedupeKey below) stay stable across a retry — reading
    // the wall clock outside a step gets recomputed on every replay, and a
    // retry that crosses the date boundary would mint a different dedupeKey
    // than the original attempt, letting a duplicate notification through.
    const { since, today } = await step.run('capture-now', async () => {
      const nowMs = Date.now()
      return {
        since: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
        today: new Date(nowMs).toISOString().split('T')[0]!,
      }
    })

    const woCreatedByOrg = await step.run('count-work-orders-created', async () => {
      const supabase = createServiceClient({ system: 'inngest:notification-digest' })
      const { data, error } = await supabase
        .from('work_orders')
        .select('org_id, vendor_id, status')
        .gte('created_at', since)

      if (error) throw new Error(`Failed to count work orders created: ${error.message}`)

      // Exclude WOs that cron-daily-wrapup's unassigned-WO section will name
      // individually this evening — see the doc comment above.
      const counts = new Map<string, number>()
      for (const row of data ?? []) {
        const stillUnassigned = row.vendor_id === null && ['pending', 'quote_requested'].includes(row.status)
        if (stillUnassigned) continue
        counts.set(row.org_id, (counts.get(row.org_id) ?? 0) + 1)
      }
      return Array.from(counts.entries())
    })

    const repuguardByOrg = await step.run('count-repuguard-drafts', async () => {
      const supabase = createServiceClient({ system: 'inngest:notification-digest' })
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
      const supabase = createServiceClient({ system: 'inngest:notification-digest' })
      for (const [orgId, count] of woCreatedByOrg) {
        if (count === 0) continue
        await createPmNotification(supabase, {
          orgId,
          type:      'work_order_created_digest',
          title:     `${count} work order${count !== 1 ? 's' : ''} created today`,
          subtitle:  'Already assigned — tonight\'s wrap-up covers any still needing a vendor',
          href:      '/maintenance',
          severity:  'blue',
          dedupeKey: `wo-created-digest-${orgId}-${today}`,
        })
        created++
      }
    })

    await step.run('write-repuguard-digest', async () => {
      const supabase = createServiceClient({ system: 'inngest:notification-digest' })
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
