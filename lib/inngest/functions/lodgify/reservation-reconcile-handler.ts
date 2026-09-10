// lib/inngest/functions/lodgify/reservation-reconcile-handler.ts
// ============================================================================
// Per-connection Lodgify booking sweep. Dispatched daily by
// lodgifyReservationReconcileCron.
//
// While webhook registration stays gated off (see lodgify-webhook.ts) this is
// the ONLY ongoing sync a Lodgify connection gets — not a backstop. It keeps
// that role afterwards as the recovery path for lost deliveries.
//
// The shell (credential, property map, empty-skip, log, report-and-rethrow) is
// shared with Hospitable's and Hostex's handlers via runProviderReconcile.
// What stays here is what actually differs: the window to sweep and the
// revenue mode.
//
//   - Bookings only. Properties are not re-fetched; a rename or a new listing
//     arrives on the next manual resync, which dispatches
//     integration/lodgify.sync.requested rather than this event.
//   - revenueMode 'new-only'. 'all' would fire one booking/confirmed per
//     confirmed booking per org every day — thousands of guaranteed no-ops.
//
// A connection whose key is gone is a NonRetriableError: the PM must
// reconnect, and burning retries daily against a dead credential only obscures
// the real failures.
// ============================================================================

import { inngest }              from '@/lib/inngest/client'
import { reconnectRequired }    from '@/lib/inngest/reconnect-required'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { runProviderReconcile } from '../shared/reconcile-shell'
import { syncLodgifyReservations } from './reservation-sync'

const PROVIDER = 'lodgify' as const
const SYSTEM   = 'inngest:lodgify-reservation-reconcile'

/**
 * One month back. Enough to pick up a cancellation or a date change on a stay
 * that has already happened, without re-reading a year of settled history
 * every day.
 */
const RECONCILE_HISTORY_MONTHS = 1

/**
 * Six months forward, matching INITIAL_SYNC_LOOKAHEAD_MONTHS. A sweep that
 * covered less than the initial sync would leave a permanent blind band beyond
 * its own horizon — and with webhooks gated off, nothing else would ever reach
 * it.
 */
const RECONCILE_LOOKAHEAD_MONTHS = 6

export const lodgifyReservationReconcileHandler = inngest.createFunction(
  {
    id:      'lodgify-reservation-reconcile-handler',
    name:    'Lodgify: Reservation Reconcile (per connection)',
    retries: 3,
    concurrency: [
      { limit: 4 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/lodgify.reservation_reconcile.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    return runProviderReconcile({
      step,
      logger,
      provider: PROVIDER,
      label:    'Lodgify',
      userId:   user_id,
      orgId:    org_id,
      system:   SYSTEM,
      readToken: async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw reconnectRequired('No Lodgify API key found — reconnect required')
        return t
      },
      sync: (getToken, propertyIdMap) => syncLodgifyReservations({
        step,
        logger,
        getToken,
        orgId:       org_id,
        userId:      user_id,
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
