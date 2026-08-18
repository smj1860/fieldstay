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

import { inngest } from '@/lib/inngest/client'
import { dispatchPerProviderConnection } from '../shared/connection-dispatch'

export const hostexReservationReconcileCron = inngest.createFunction(
  {
    id:      'hostex-reservation-reconcile-cron',
    name:    'Hostex: Daily Reservation Reconcile Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hostex-reservation-reconcile-cron"' },
  },
  { cron: '0 8 * * *' },
  async ({ step, logger }) =>
    dispatchPerProviderConnection({
      step,
      logger,
      provider:       'hostex',
      system:         'inngest:hostex-reservation-reconcile-cron',
      label:          'hostex-reservation-reconcile-cron.connections',
      dispatchStepId: 'dispatch-reconcile-events',
      eventName:      'integration/hostex.reservation_reconcile.requested',
      logPrefix:      '[Hostex reconcile cron]',
    })
)
