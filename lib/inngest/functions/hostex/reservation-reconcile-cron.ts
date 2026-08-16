// lib/inngest/functions/hostex/reservation-reconcile-cron.ts
// ============================================================================
// Daily cron — dispatches one reservation-reconcile event per active Hostex
// connection.
//
// Daily rather than the weekly backstop Hospitable and OwnerRez run, because
// Hostex webhooks are strictly less reliable than theirs: Hostex allows a
// 3-second ack and then NEVER RETRIES a failed delivery (see
// app/api/webhooks/hostex/[token]/route.ts). A missed delivery is missed for
// good, so the sweep that recovers it has to run often.
//
// Same dispatch-per-connection shape as the Hospitable crons: this function
// only FINDS connections, and one run per connection does the work under its
// own concurrency cap and retry policy — so a rate-limited or broken
// connection retries alone instead of breaking the tick for every other
// tenant.
//
// Schedule: daily at 08:00 UTC — clear of the 09:00 Hospitable teammate cron,
// 09:30 calendar, 10:00 Hospitable reconcile, 11:00 OwnerRez reconciliation,
// and the 13:00/14:00 cluster.
// ============================================================================

import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'

const PROVIDER = 'hostex'
const SYSTEM   = 'inngest:hostex-reservation-reconcile-cron'

interface HostexConnectionRow {
  user_id:          string
  org_id:           string | null
  external_user_id: string | null
}

export const hostexReservationReconcileCron = inngest.createFunction(
  {
    id:      'hostex-reservation-reconcile-cron',
    name:    'Hostex: Daily Reservation Reconcile Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hostex-reservation-reconcile-cron"' },
  },
  { cron: '0 8 * * *' },
  async ({ step, logger }) => {
    const connections = await step.run('fetch-active-connections', async () => {
      const supabase = createServiceClient({ system: SYSTEM })

      // PLATFORM-WIDE scan — every org with a live Hostex connection. At
      // max_rows = 1000 PostgREST returns the first 1000 with a 200 and no
      // truncation signal, so every connection past that would silently stop
      // syncing while the cron still reported success.
      //
      // org_id NOT NULL is load-bearing, not tidiness: the handler scopes
      // every read and write by it.
      return fetchAllRows<HostexConnectionRow>(
        (from, to) => supabase
          .from('integration_connections')
          .select('user_id, org_id, external_user_id')
          .eq('provider_id', PROVIDER)
          .eq('status',      'active')
          .not('org_id',     'is', null)
          .order('user_id')
          .range(from, to),
        { label: 'hostex-reservation-reconcile-cron.connections' },
      )
    })

    logger.info(`[Hostex reconcile cron] Dispatching for ${connections.length} connections`)

    if (connections.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'dispatch-reconcile-events',
      connections.map((c) => ({
        name: 'integration/hostex.reservation_reconcile.requested' as const,
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
