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

import { inngest } from '@/lib/inngest/client'
import { dispatchPerProviderConnection } from '../shared/connection-dispatch'

export const hospReservationReconcileCron = inngest.createFunction(
  {
    id:      'hospitable-reservation-reconcile-cron',
    name:    'Hospitable: Daily Reservation Reconcile Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hospitable-reservation-reconcile-cron"' },
  },
  { cron: '0 10 * * *' },
  async ({ step, logger }) =>
    dispatchPerProviderConnection({
      step,
      logger,
      provider:       'hospitable',
      system:         'inngest:hospitable-reservation-reconcile-cron',
      label:          'hospitable-reservation-reconcile-cron.connections',
      dispatchStepId: 'dispatch-reconcile-events',
      eventName:      'integration/hospitable.reservation_reconcile.requested',
      logPrefix:      '[Hospitable reconcile cron]',
    })
)
