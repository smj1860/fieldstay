import { inngest }            from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * SCHEDULED: runs monthly on the 1st at 3am UTC.
 *
 * Enforces the audit event data retention policy:
 *  - Financial actions (billing.*, owner.transaction.*): 7 years (IRS/GAAP)
 *  - All other audit events: 3 years (SOC2 Type II / GDPR)
 *
 * Delegates to the purge_expired_audit_events() PostgreSQL function
 * so the delete runs as a single DB transaction rather than fetching rows
 * into application memory.
 */
export const auditRetentionCron = inngest.createFunction(
  {
    id:      'cron-audit-retention',
    name:    'Cron: Audit Event Retention Purge',
    retries: 1,
  },
  { cron: '0 3 1 * *' },  // 1st of each month at 3am UTC
  async ({ step, logger }) => {
    const result = await step.run('purge-expired-audit-events', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase.rpc('purge_expired_audit_events')
      if (error) throw new Error(`purge_expired_audit_events failed: ${error.message}`)
      return data as { financial_deleted: number; operational_deleted: number; run_at: string }
    })

    logger.info(
      `Audit retention — financial deleted: ${result.financial_deleted}, ` +
      `operational deleted: ${result.operational_deleted}`
    )

    return result
  }
)
