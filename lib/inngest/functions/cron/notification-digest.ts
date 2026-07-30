import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { fetchAllRows }         from '@/lib/inngest/paginate'

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

    // Both scans are paginated: unbounded, they were capped at PostgREST's
    // 1000-row limit with no error, so once platform-wide 24h volume crossed
    // that line every org sorted late simply received no digest at all.
    const woCreatedByOrg = await step.run('count-work-orders-created', async () => {
      const supabase = createServiceClient({ system: 'inngest:notification-digest' })
      const rows = await fetchAllRows<{ org_id: string; vendor_id: string | null; status: string }>(
        (from, to) => supabase
          .from('work_orders')
          .select('org_id, vendor_id, status')
          .gte('created_at', since)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'work_orders(digest)' }
      )

      // Exclude WOs that cron-daily-wrapup's unassigned-WO section will name
      // individually this evening — see the doc comment above.
      const counts = new Map<string, number>()
      for (const row of rows) {
        const stillUnassigned = row.vendor_id === null && ['pending', 'quote_requested'].includes(row.status)
        if (stillUnassigned) continue
        counts.set(row.org_id, (counts.get(row.org_id) ?? 0) + 1)
      }
      return Array.from(counts.entries())
    })

    const repuguardByOrg = await step.run('count-repuguard-drafts', async () => {
      const supabase = createServiceClient({ system: 'inngest:notification-digest' })
      const rows = await fetchAllRows<{ org_id: string }>(
        (from, to) => supabase
          .from('review_responses')
          .select('org_id')
          .gte('generated_at', since)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'review_responses(digest)' }
      )

      const counts = new Map<string, number>()
      for (const row of rows) {
        counts.set(row.org_id, (counts.get(row.org_id) ?? 0) + 1)
      }
      return Array.from(counts.entries())
    })

    // ONE insert for every org instead of 150 sequential createPmNotification
    // round-trips inside a single step. `notifications.dedupe_key` has a
    // partial UNIQUE index, so ignoreDuplicates gives exactly the same
    // retry/duplicate-cron protection createPmNotification's 23505 swallow
    // provided, in a single statement.
    const created = await step.run('write-digest-notifications', async () => {
      const supabase = createServiceClient({ system: 'inngest:notification-digest' })

      const rows = [
        ...woCreatedByOrg
          .filter(([, count]) => count > 0)
          .map(([orgId, count]) => ({
            org_id:     orgId,
            type:       'work_order_created_digest',
            title:      `${count} work order${count !== 1 ? 's' : ''} created today`,
            subtitle:   'Already assigned — tonight\'s wrap-up covers any still needing a vendor',
            href:       '/maintenance',
            severity:   'blue',
            dedupe_key: `wo-created-digest-${orgId}-${today}`,
          })),
        ...repuguardByOrg
          .filter(([, count]) => count > 0)
          .map(([orgId, count]) => ({
            org_id:     orgId,
            type:       'repuguard_digest',
            title:      `${count} review draft${count !== 1 ? 's' : ''} ready`,
            subtitle:   'RepuGuard generated new drafts for your review',
            href:       '/reviews',
            severity:   'blue',
            dedupe_key: `repuguard-digest-${orgId}-${today}`,
          })),
      ]

      if (!rows.length) return 0

      // notifications.dedupe_key is backed by a PARTIAL unique index
      // (WHERE dedupe_key IS NOT NULL), which Postgres cannot use as an
      // ON CONFLICT arbiter through PostgREST — so dedupe is a pre-filter
      // (one query for all keys) plus a 23505 swallow for the narrow race
      // where a concurrent rerun inserts between the read and the write.
      const keys = rows.map((r) => r.dedupe_key)
      const { data: existing, error: existingError } = await supabase
        .from('notifications')
        .select('dedupe_key')
        .in('dedupe_key', keys)

      if (existingError) throw new Error(`Failed to check digest dedupe keys: ${existingError.message}`)

      const seen = new Set((existing ?? []).map((r) => r.dedupe_key))
      const toInsert = rows.filter((r) => !seen.has(r.dedupe_key))
      if (!toInsert.length) return 0

      const { data, error } = await supabase
        .from('notifications')
        .insert(toInsert)
        .select('id')

      // 23505 = the dedupe race above; 23503 = FK violation on org_id, an org
      // deleted out of band between the count scan and this write. Neither is
      // retriable and neither leaves anyone to notify.
      if (error && error.code !== '23505' && error.code !== '23503') {
        throw new Error(`Failed to write digest notifications: ${error.message}`)
      }
      if (error) {
        console.warn('[notification-digest] digest insert skipped', { code: error.code })
        return 0
      }

      return data?.length ?? 0
    })

    logger.info(`Notification digest: ${created} notification(s) written`)
    return { notifications_created: created }
  }
)
