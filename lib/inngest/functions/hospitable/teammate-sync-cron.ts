// lib/inngest/functions/hospitable/teammate-sync-cron.ts
// ============================================================
// Daily cron — dispatches one teammate resync event per active Hospitable
// connection. Hospitable has no teammate.* webhook (confirmed against the
// partner API docs), so initial-sync.ts's one-time teammate fetch is the
// only sync that would otherwise ever happen — a crew member added,
// reassigned, or removed in Hospitable after connecting would never be
// reflected in FieldStay. This closes that gap with a lightweight full
// resync once a day, same dispatch-per-connection pattern as
// integrationTokenRefreshCron so one org's failure never blocks another's.
//
// Schedule: daily at 09:00 UTC — clear of the 13:00/14:00 UTC cron cluster
// (maintenance-schedules, work-order-ops, asset-health, comms-retention,
// turnover-priority-decay all run then).
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'

export const hospTeammateSyncCron = inngest.createFunction(
  {
    id:      'hospitable-teammate-sync-cron',
    name:    'Hospitable: Daily Teammate Resync Cron',
    retries: 1,
    // Prevent overlapping runs if manually triggered while a scheduled run is active
    concurrency: { limit: 1, key: '"hospitable-teammate-sync-cron"' },
  },
  { cron: '0 9 * * *' },
  async ({ step, logger }) => {

    const connections = await step.run('fetch-active-connections', async () => {
      const supabase = createServiceClient({ system: 'inngest:teammate-sync-cron' })

      // PLATFORM-WIDE scan — every org with a live Hospitable connection, not
      // one tenant's. At max_rows = 1000 PostgREST returns the first 1000 with
      // a 200 and no truncation signal, so every connection past that stops
      // being resynced entirely while the cron still reports success.
      return await fetchAllRows<{ user_id: string; org_id: string | null; external_user_id: string | null }>(
        (from, to) => supabase
          .from('integration_connections')
          .select('user_id, org_id, external_user_id')
          .eq('provider_id', 'hospitable')
          .eq('status',      'active')
          .not('org_id',     'is', null)
          .order('user_id')
          .range(from, to),
        { label: 'hospitable-teammate-sync-cron.connections' },
      )
    })

    logger.info(`[Hospitable teammate-sync cron] Dispatching resync for ${connections.length} connections`)

    if (connections.length === 0) {
      return { dispatched: 0 }
    }

    await step.sendEvent(
      'dispatch-teammate-sync-events',
      connections.map((c) => ({
        name: 'integration/hospitable.teammate_sync.requested' as const,
        data: {
          user_id:          c.user_id,
          org_id:           c.org_id!,
          external_user_id: c.external_user_id ?? '',
        },
      }))
    )

    return { dispatched: connections.length }
  }
)
