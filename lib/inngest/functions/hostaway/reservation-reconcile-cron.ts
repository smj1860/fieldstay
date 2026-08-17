// lib/inngest/functions/hostaway/reservation-reconcile-cron.ts
// ============================================================================
// Daily cron — dispatches one reservation-reconcile event per active Hostaway
// connection.
//
// Daily rather than weekly, and for now this is the ONLY thing keeping a
// Hostaway org in sync: webhooks are a later phase, so every change a PM makes
// in Hostaway reaches FieldStay through this sweep or not at all. Once webhooks
// land it becomes the backstop, the same role it plays for Hostex.
//
// Same dispatch-per-connection shape as the Hospitable and Hostex crons: this
// function only FINDS connections, and one run per connection does the work
// under its own concurrency cap and retry policy — so a rate-limited or broken
// connection retries alone instead of breaking the tick for every other tenant.
//
// Schedule: daily at 07:30 UTC. Deliberately ahead of the 08:00 Hostex
// reconcile and clear of the 09:00/09:30/10:00/11:00 PMS cluster — the crons
// share a Supabase instance, and stacking every provider's platform-wide
// connection scan on the same minute is how one slow provider becomes
// everyone's slow provider.
// ============================================================================

import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'

const PROVIDER = 'hostaway'
const SYSTEM   = 'inngest:hostaway-reservation-reconcile-cron'

interface HostawayConnectionRow {
  user_id:          string
  org_id:           string | null
  external_user_id: string | null
}

export const hostawayReservationReconcileCron = inngest.createFunction(
  {
    id:      'hostaway-reservation-reconcile-cron',
    name:    'Hostaway: Daily Reservation Reconcile Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hostaway-reservation-reconcile-cron"' },
  },
  { cron: '30 7 * * *' },
  async ({ step, logger }) => {
    const connections = await step.run('fetch-active-connections', async () => {
      const supabase = createServiceClient({ system: SYSTEM })

      // PLATFORM-WIDE scan — every org with a live Hostaway connection. At
      // max_rows = 1000 PostgREST returns the first 1000 with a 200 and no
      // truncation signal, so every connection past that would silently stop
      // syncing while the cron still reported success.
      //
      // org_id NOT NULL is load-bearing, not tidiness: the handler scopes every
      // read and write by it.
      return fetchAllRows<HostawayConnectionRow>(
        (from, to) => supabase
          .from('integration_connections')
          .select('user_id, org_id, external_user_id')
          .eq('provider_id', PROVIDER)
          .eq('status',      'active')
          .not('org_id',     'is', null)
          .order('user_id')
          .range(from, to),
        { label: 'hostaway-reservation-reconcile-cron.connections' },
      )
    })

    logger.info(`[Hostaway reconcile cron] Dispatching for ${connections.length} connections`)

    if (connections.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'dispatch-reconcile-events',
      connections.map((c) => ({
        name: 'integration/hostaway.reservation_reconcile.requested' as const,
        data: {
          user_id:          c.user_id,
          org_id:           c.org_id!,
          external_user_id: c.external_user_id ?? '',
        },
      })),
    )

    return { dispatched: connections.length }
  }
)
