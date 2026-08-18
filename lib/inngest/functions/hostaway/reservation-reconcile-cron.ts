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

import { inngest } from '@/lib/inngest/client'
import { dispatchPerProviderConnection } from '../shared/connection-dispatch'

export const hostawayReservationReconcileCron = inngest.createFunction(
  {
    id:      'hostaway-reservation-reconcile-cron',
    name:    'Hostaway: Daily Reservation Reconcile Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hostaway-reservation-reconcile-cron"' },
  },
  { cron: '30 7 * * *' },
  async ({ step, logger }) =>
    dispatchPerProviderConnection({
      step,
      logger,
      provider:       'hostaway',
      system:         'inngest:hostaway-reservation-reconcile-cron',
      label:          'hostaway-reservation-reconcile-cron.connections',
      dispatchStepId: 'dispatch-reconcile-events',
      eventName:      'integration/hostaway.reservation_reconcile.requested',
      logPrefix:      '[Hostaway reconcile cron]',
    })
)
