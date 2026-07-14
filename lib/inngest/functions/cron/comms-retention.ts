import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'

/**
 * SCHEDULED: runs daily at 9am CT — staggered 1hr after the other maintenance
 * crons to avoid Supabase contention. Pure data-lifecycle concern, isolated here.
 *
 *  • 6.14 — comms log retention: soft-deletes logs past the org's retention
 *           window, then hard-purges logs that have been soft-deleted 30+ days
 */
export const dailyCommsRetention = inngest.createFunction(
  {
    id:      'cron-comms-retention',
    name:    'Cron: Comms Log Retention Purge',
    retries: 1,
  },
  { cron: '0 14 * * *' },  // stagger 1hr to avoid Supabase contention
  async ({ step, logger }) => {
    const today = new Date()

    const retentionOrgs = await step.run('find-comms-retention-orgs', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('organizations')
        .select('id, comms_log_retention_days')

      return data ?? []
    })

    let commsSoftDeleted = 0
    let commsHardPurged  = 0

    for (const org of retentionOrgs) {
      await step.run(`comms-log-retention-${org.id}`, async () => {
        const supabase = createServiceClient()
        // Step A — soft-delete logs older than the retention window
        const { data: softDeleted } = await supabase
          .from('communication_logs')
          .update({ deleted_at: new Date().toISOString() })
          .eq('org_id', org.id)
          .is('deleted_at', null)
          .lt('created_at', new Date(today.getTime() - org.comms_log_retention_days * 86_400_000).toISOString())
          .select('id')

        // Step B — hard purge logs soft-deleted more than 30 days ago
        const { data: hardPurged } = await supabase
          .from('communication_logs')
          .delete()
          .eq('org_id', org.id)
          .not('deleted_at', 'is', null)
          .lt('deleted_at', new Date(today.getTime() - 30 * 86_400_000).toISOString())
          .select('id')

        commsSoftDeleted += softDeleted?.length ?? 0
        commsHardPurged  += hardPurged?.length ?? 0

        const auditEntries = []
        if (softDeleted?.length) {
          auditEntries.push({
            orgId:      org.id,
            action:     'comms.log.deleted' as const,
            targetType: 'communication_log',
            metadata:   { source: 'retention_cron', count: softDeleted.length, stage: 'soft_delete' },
          })
        }
        if (hardPurged?.length) {
          auditEntries.push({
            orgId:      org.id,
            action:     'comms.log.deleted' as const,
            targetType: 'communication_log',
            metadata:   { source: 'retention_cron', count: hardPurged.length, stage: 'hard_purge' },
          })
        }
        if (auditEntries.length) await logAuditEvents(auditEntries)

        return { soft_deleted: softDeleted?.length ?? 0, hard_purged: hardPurged?.length ?? 0 }
      })
    }

    logger.info(`Comms log retention — soft-deleted ${commsSoftDeleted}, hard-purged ${commsHardPurged}`)

    return {
      comms_soft_deleted: commsSoftDeleted,
      comms_hard_purged:  commsHardPurged,
    }
  }
)
