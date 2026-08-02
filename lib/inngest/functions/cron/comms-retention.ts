import { unwrap } from '@/lib/supabase/unwrap'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { fetchAllRows } from '@/lib/inngest/paginate'

/**
 * SCHEDULED: runs daily at 9am CT — staggered off the other maintenance crons
 * to avoid Supabase contention. Pure data-lifecycle concern, isolated here.
 *
 *  • 6.14 — comms log retention: soft-deletes logs past the org's retention
 *           window, then hard-purges logs that have been soft-deleted 30+ days
 *
 * DISPATCHER ONLY. This previously ran one `step.run` per org inside a single
 * invocation — 150 steps at 150 tenants, breaking somewhere around 500-800.
 * Now it fans out one `org/comms_retention.requested` per org.
 */
export const dailyCommsRetention = inngest.createFunction(
  {
    id:      'cron-comms-retention',
    name:    'Cron: Comms Log Retention Purge',
    retries: 1,
  },
  { cron: '0 14 * * *' },  // stagger 1hr to avoid Supabase contention
  async ({ step, logger }) => {
    const nowMs = await step.run('capture-now', async () => Date.now())

    const orgIds = await step.run('find-comms-retention-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:comms-retention' })
      const orgs = await fetchAllRows<{ id: string }>(
        (from, to) => supabase
          .from('organizations')
          .select('id')
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'organizations(comms-retention)' }
      )
      return orgs.map((o) => o.id)
    })

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-comms-retention',
        orgIds.map((orgId) => ({
          name: 'org/comms_retention.requested' as const,
          data: { org_id: orgId, now_ms: nowMs },
        }))
      )
    }

    logger.info(`Comms log retention: dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  }
)

/**
 * Per-org comms retention. One invocation = one tenant, so total step count is
 * flat in tenant count and a failing tenant retries only itself.
 *
 * Both statements are naturally idempotent: the soft-delete filters
 * `deleted_at IS NULL` and the hard purge only removes already-soft-deleted
 * rows, so a retry re-selects nothing.
 */
export const commsRetentionOrg = inngest.createFunction(
  {
    id:          'comms-retention-org',
    name:        'Comms Log Retention — per org',
    retries:     1,
    concurrency: { limit: 10 },
  },
  { event: 'org/comms_retention.requested' },
  async ({ event, step }) => {
    const orgId = event.data.org_id
    const nowMs = event.data.now_ms

    return await step.run('purge-comms-logs', async () => {
      const supabase = createServiceClient({ system: 'inngest:comms-retention' })

      // A failed read used to surface as reason: 'org_missing', which reads
      // as "nothing to do for this tenant" rather than "retention did not run".
      const orgRes = await supabase
        .from('organizations')
        .select('comms_log_retention_days')
        .eq('id', orgId)
        .maybeSingle()

      const org = unwrap(orgRes, { site: 'inngest.comms-retention.org', orgId })

      if (!org) return { org_id: orgId, soft_deleted: 0, hard_purged: 0, reason: 'org_missing' }

      // Step A — soft-delete logs older than the retention window
      const { data: softDeleted, error: softError } = await supabase
        .from('communication_logs')
        .update({ deleted_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .is('deleted_at', null)
        .lt('created_at', new Date(nowMs - org.comms_log_retention_days * 86_400_000).toISOString())
        .select('id')

      if (softError) throw new Error(`Comms soft-delete failed for org ${orgId}: ${softError.message}`)

      // Step B — hard purge logs soft-deleted more than 30 days ago
      const { data: hardPurged, error: hardError } = await supabase
        .from('communication_logs')
        .delete()
        .eq('org_id', orgId)
        .not('deleted_at', 'is', null)
        .lt('deleted_at', new Date(nowMs - 30 * 86_400_000).toISOString())
        .select('id')

      if (hardError) throw new Error(`Comms hard-purge failed for org ${orgId}: ${hardError.message}`)

      const auditEntries = []
      if (softDeleted?.length) {
        auditEntries.push({
          orgId,
          action:     'comms.log.deleted' as const,
          targetType: 'communication_log',
          metadata:   { source: 'retention_cron', count: softDeleted.length, stage: 'soft_delete' },
        })
      }
      if (hardPurged?.length) {
        auditEntries.push({
          orgId,
          action:     'comms.log.deleted' as const,
          targetType: 'communication_log',
          metadata:   { source: 'retention_cron', count: hardPurged.length, stage: 'hard_purge' },
        })
      }
      if (auditEntries.length) await logAuditEvents(auditEntries)

      return {
        org_id:       orgId,
        soft_deleted: softDeleted?.length ?? 0,
        hard_purged:  hardPurged?.length ?? 0,
      }
    })
  }
)
