// lib/inngest/functions/hostex/reservation-reconcile-handler.ts
// ============================================================================
// Per-connection Hostex reservation sweep. Dispatched daily by
// hostexReservationReconcileCron.
//
// Since Phase 2 this is a BACKSTOP rather than the only sync: webhooks deliver
// changes in near real time. It still matters more here than the equivalent
// does for Hospitable, because Hostex allows 3 seconds to acknowledge a
// delivery and NEVER retries one that misses — anything dropped is dropped
// permanently, and this is what recovers it.
//
// The shell (token, property map, empty-skip, log, report-and-rethrow) is
// shared with Hospitable's handler via runProviderReconcile. What stays here
// is what actually differs: the window to sweep and the revenue mode.
//
//   - Reservations only. Properties are not re-fetched; a rename or a new
//     listing arrives on the next initial sync or manual resync. (Manual
//     resync DOES re-read properties — it dispatches integration/hostex.connected,
//     not this event.)
//   - revenueMode 'new-only'. 'all' would fire one booking/confirmed per
//     confirmed booking per org every day — thousands of guaranteed no-ops.
//
// A connection whose token is gone is a NonRetriableError: the PM must
// reconnect, and burning retries daily against a dead credential only obscures
// the real failures. It does NOT flip the connection to 'error' — that is
// integration-token-refresh-handler's job, which owns the reconnect email and
// its dedup flag, and a daily cron racing it would send duplicates.
// ============================================================================

import { inngest }             from '@/lib/inngest/client'
import { NonRetriableError }   from 'inngest'
import { getValidHostexToken } from '@/lib/integrations/providers/hostex-token'
import { runProviderReconcile } from '../shared/reconcile-shell'
import { syncHostexReservations } from './reservation-sync'

const PROVIDER = 'hostex' as const
const SYSTEM   = 'inngest:hostex-reservation-reconcile'

/**
 * One month back. Enough to pick up a cancellation or a date change on a stay
 * that has already happened, without re-reading a year of settled history
 * every day.
 */
const RECONCILE_HISTORY_MONTHS = 1

/**
 * Six months forward, matching INITIAL_SYNC_LOOKAHEAD_MONTHS. A sweep that
 * covered less than the initial sync would leave a permanent blind band beyond
 * its own horizon, reachable only by a webhook the provider never retries.
 */
const RECONCILE_LOOKAHEAD_MONTHS = 6

export const hostexReservationReconcileHandler = inngest.createFunction(
  {
    id:      'hostex-reservation-reconcile-handler',
    name:    'Hostex: Reservation Reconcile (per connection)',
    retries: 3,
    concurrency: [
      { limit: 4 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/hostex.reservation_reconcile.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    return runProviderReconcile({
      step,
      logger,
      provider: PROVIDER,
      label:    'Hostex',
      userId:   user_id,
      orgId:    org_id,
      system:   SYSTEM,
      readToken: async () => {
        const t = await getValidHostexToken(user_id)
        if (!t) throw new NonRetriableError('No Hostex token found — reconnect required')
        return t
      },
      sync: (token, propertyIdMap) => syncHostexReservations({
        step,
        logger,
        token,
        orgId:         org_id,
        userId:        user_id,
        propertyIdMap,
        fetchMode: {
          kind:            'window',
          historyMonths:   RECONCILE_HISTORY_MONTHS,
          lookaheadMonths: RECONCILE_LOOKAHEAD_MONTHS,
        },
        system:      SYSTEM,
        revenueMode: 'new-only',
      }),
    })
  }
)
