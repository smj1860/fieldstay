// lib/inngest/functions/ownerrez/reconciliation-cron.ts
// ============================================================
// Daily cron — dispatches one hard-delete reconciliation event per active
// OwnerRez connection. incremental-sync.ts's since_utc-filtered getBookings()
// call only ever upserts whatever OwnerRez currently returns — if OwnerRez
// hard-deletes a booking or quote-hold/block (rather than status-changing it
// to cancelled), a since_utc-filtered list endpoint (typical REST behavior)
// simply omits it from future responses, and the stale row would otherwise
// persist in FieldStay forever (see FUTURE_REMEDIATION.md item 6). Same
// dispatch-per-connection pattern as hospTeammateSyncCron.
//
// Schedule: daily at 11:00 UTC — clear of the 09:00/09:30 Hospitable crons
// and the 13:00/14:00 UTC cron cluster.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const ownerRezReconciliationCron = inngest.createFunction(
  {
    id:      'ownerrez-reconciliation-cron',
    name:    'OwnerRez: Daily Hard-Delete Reconciliation Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"ownerrez-reconciliation-cron"' },
  },
  { cron: '0 11 * * *' },
  async ({ step, logger }) => {

    const connections = await step.run('fetch-active-connections', async () => {
      const supabase = createServiceClient({ system: 'inngest:reconciliation-cron' })

      const { data, error } = await supabase
        .from('integration_connections')
        .select('user_id, org_id')
        .eq('provider_id', 'ownerrez')
        .eq('status',      'active')
        .not('org_id',     'is', null)

      if (error) throw new Error(`Failed to fetch connections: ${error.message}`)
      return data ?? []
    })

    logger.info(`[OwnerRez reconciliation cron] Dispatching for ${connections.length} connections`)

    if (connections.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'dispatch-reconciliation-events',
      connections.map((c) => ({
        name: 'integration/ownerrez.reconcile.requested' as const,
        data: { user_id: c.user_id, org_id: c.org_id! },
      }))
    )

    return { dispatched: connections.length }
  }
)
