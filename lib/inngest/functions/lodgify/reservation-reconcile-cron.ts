// lib/inngest/functions/lodgify/reservation-reconcile-cron.ts
// ============================================================================
// Daily cron — dispatches one reservation-reconcile event per active Lodgify
// connection.
//
// DAILY, and for Lodgify this is the PRIMARY sync rather than a backstop:
// webhook registration is gated off by default (see lodgify-webhook.ts), so
// until a real account confirms Lodgify's webhook contract this cron is the
// only thing keeping a connected org current. It stays daily afterwards, as
// the recovery path for a delivery that was dropped, mis-parsed, or arrived
// during a deploy.
//
// Same dispatch-per-connection shape as the other PMS crons: this function
// only FINDS connections, and one run per connection does the work under its
// own concurrency cap and retry policy — so a rate-limited or broken
// connection retries alone instead of breaking the tick for every other
// tenant.
//
// Schedule: daily at 07:00 UTC — clear of the 08:00 Hostex reconcile, the
// 09:00 Hospitable teammate cron, 09:30 calendar, 10:00 Hospitable reconcile,
// 11:00 OwnerRez reconciliation, and the 13:00/14:00 cluster.
// ============================================================================

import { inngest } from '@/lib/inngest/client'
import { dispatchPerProviderConnection } from '../shared/connection-dispatch'

export const lodgifyReservationReconcileCron = inngest.createFunction(
  {
    id:      'lodgify-reservation-reconcile-cron',
    name:    'Lodgify: Daily Reservation Reconcile Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"lodgify-reservation-reconcile-cron"' },
  },
  { cron: '0 7 * * *' },
  async ({ step, logger }) =>
    dispatchPerProviderConnection({
      step,
      logger,
      provider:       'lodgify',
      system:         'inngest:lodgify-reservation-reconcile-cron',
      label:          'lodgify-reservation-reconcile-cron.connections',
      dispatchStepId: 'dispatch-reconcile-events',
      eventName:      'integration/lodgify.reservation_reconcile.requested',
      logPrefix:      '[Lodgify reconcile cron]',
    })
)
