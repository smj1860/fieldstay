// lib/inngest/functions/hospitable/reservation-reconcile-cron.ts
// ============================================================
// Daily cron — dispatches one reservation-reconcile event per active
// Hospitable connection.
//
// THE GAP THIS CLOSES
//
// Hospitable reservations were WEBHOOK-ONLY. hospIncrementalSync fires solely
// from `integration/hospitable.sync.requested`, whose only senders are the
// webhook path in lib/integrations/providers/hospitable.ts. Reservation
// history was pulled exactly once, by hospInitialSync on connect. The two
// existing Hospitable crons don't help: hospCalendarSyncCron syncs calendar
// BLOCKS (Hospitable's /reservations endpoint never represents one) and
// hospTeammateSyncCron syncs crew.
//
// So any reservation created or changed while webhooks were not being
// delivered — a rotated signing secret, a provider outage, deliveries the
// provider eventually stops retrying — never arrived, and nothing ever
// noticed. Found 2026-08-15 after a webhook-secret rotation left a live
// customer's reservations dependent on deliveries that had been rejected for
// hours. That org turned out to have lost nothing, but only because someone
// was watching; there was no mechanism that would have caught it.
//
// This is the same missed-webhook backstop OwnerRez already has as the hourly
// leg of ownerRezIncrementalSync's trigger array, and it uses the same
// dispatch-per-connection shape as ownerRezReconciliationCron /
// hospTeammateSyncCron / hospCalendarSyncCron: this function only FINDS
// connections, and one run per connection does the work under its own
// concurrency cap and retry policy. A rate-limited connection then retries
// alone instead of breaking the whole tick for every other tenant.
//
// Schedule: daily at 10:00 UTC — clear of the 09:00 teammate cron, the 09:30
// calendar cron, OwnerRez's 11:00 reconciliation, and the 13:00/14:00 cluster.
// Daily rather than hourly because the webhook path is primary and healthy;
// this only has to bound how long a missed reservation can stay missing.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'

export const hospReservationReconcileCron = inngest.createFunction(
  {
    id:      'hospitable-reservation-reconcile-cron',
    name:    'Hospitable: Daily Reservation Reconcile Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hospitable-reservation-reconcile-cron"' },
  },
  { cron: '0 10 * * *' },
  async ({ step, logger }) => {

    const connections = await step.run('fetch-active-connections', async () => {
      const supabase = createServiceClient({ system: 'inngest:hospitable-reservation-reconcile-cron' })

      // PLATFORM-WIDE scan — every org with a live Hospitable connection, not
      // one tenant's. At max_rows = 1000 PostgREST returns the first 1000 with
      // a 200 and no truncation signal, so every connection past that would
      // stop being reconciled while the cron still reported success.
      //
      // org_id NOT NULL is required, not merely tidy: the handler scopes every
      // read and write by it, and a connection without one has nothing to
      // reconcile against.
      return await fetchAllRows<{ user_id: string; org_id: string | null; external_user_id: string | null }>(
        (from, to) => supabase
          .from('integration_connections')
          .select('user_id, org_id, external_user_id')
          .eq('provider_id', 'hospitable')
          .eq('status',      'active')
          .not('org_id',     'is', null)
          .order('user_id')
          .range(from, to),
        { label: 'hospitable-reservation-reconcile-cron.connections' },
      )
    })

    logger.info(`[Hospitable reconcile cron] Dispatching for ${connections.length} connections`)

    if (connections.length === 0) return { dispatched: 0 }

    await step.sendEvent(
      'dispatch-reconcile-events',
      connections.map((c) => ({
        name: 'integration/hospitable.reservation_reconcile.requested' as const,
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
