// lib/inngest/functions/hospitable/reservation-reconcile-handler.ts
// ============================================================
// Per-connection reservation reconcile. Dispatched by
// hospReservationReconcileCron — see that file's header for the gap this
// closes (Hospitable reservations were webhook-only, with no scheduled
// catch-up of any kind).
//
// Runs the SAME pipeline as the initial sync's reservation half, via the
// shared syncHospitableReservations() — deliberately not a second copy of the
// upsert, the two silent-drop guards, and the turnover regeneration.
//
// Three differences from hospInitialSync, all intentional:
//
//   1. Reservations ONLY. Properties, teammates, guidebook configs and asset
//      seeding are not re-fetched. Those have their own crons or their own
//      webhooks, and re-running them daily would multiply this job's cost
//      against a shared platform rate-limit budget for no benefit.
//
//   2. The property map is read from OUR database, not from Hospitable. The
//      initial sync builds it as a by-product of upserting properties; here
//      there is nothing to upsert, and a properties fetch per connection per
//      day is exactly the budget waste point 1 avoids.
//
//   3. revenueMode 'new-only'. 'all' would fire one booking/confirmed per
//      confirmed booking per org EVERY DAY — thousands of guaranteed no-ops
//      (the post dedups on source_reference_id) to catch the handful webhooks
//      actually missed. See RevenueMode in reservation-sync.ts.
//
// A connection whose token is gone is a NonRetriableError: the PM must
// reconnect, and burning five retries a day against a dead credential only
// obscures the real ones. It does NOT flip the connection to 'error' — that
// is integration-token-refresh-handler's job, which owns the reconnect email
// and its dedup flag; a daily cron racing it would send duplicates.
//
// The shell around all of that (token, property map, empty-skip, log,
// report-and-rethrow) moved to runProviderReconcile on 2026-08-16, when the
// Hostex handler landed as a near-copy of it. What stays here is what actually
// differs between the two: the lookahead and the revenue mode.
// ============================================================

import { inngest }              from '@/lib/inngest/client'
import { NonRetriableError }    from 'inngest'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { runProviderReconcile } from '../shared/reconcile-shell'
import { syncHospitableReservations } from './reservation-sync'

const PROVIDER = 'hospitable'
const SYSTEM   = 'inngest:hospitable-reservation-reconcile'

/**
 * How far forward each reconcile sweeps, in months. Matches
 * INITIAL_SYNC_LOOKAHEAD_MONTHS: a reconcile that covered less than the
 * initial sync would leave a permanent blind band beyond its own horizon —
 * bookings far enough out that only the (missed) webhook would ever have
 * delivered them.
 *
 * The lower bound is not a parameter: hospReservationWindows() starts 7 days
 * back when given no `since`, which is the overlap a DAILY job needs.
 */
const RECONCILE_LOOKAHEAD_MONTHS = 3

export const hospReservationReconcileHandler = inngest.createFunction(
  {
    id:      'hospitable-reservation-reconcile-handler',
    name:    'Hospitable: Reservation Reconcile (per connection)',
    retries: 3,
    // Two limits, same reasoning as hospInitialSync's. The keyed one stops a
    // connection from reconciling on top of itself if a tick runs long; the
    // unkeyed PLATFORM cap stops N orgs fanning out unbounded against one
    // shared Hospitable rate-limit budget — with a daily cron, every
    // connection is dispatched in the same instant, so this is the load-
    // bearing one.
    concurrency: [
      { limit: 3 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/hospitable.reservation_reconcile.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    return runProviderReconcile({
      step,
      logger,
      provider: PROVIDER,
      label:    'Hospitable',
      userId:   user_id,
      orgId:    org_id,
      system:   SYSTEM,
      readToken: async () => {
        // getValidHospitableToken, NOT readIntegrationToken. The raw Vault read
        // returns whatever is stored WITHOUT checking expiry or refreshing, and
        // Hospitable access tokens live 12 hours.
        //
        // That produced a live 401 on 2026-08-18: this cron fires at 10:00 UTC,
        // and one connection's token expired at 10:00:06 — the refresh cron
        // renewed it six seconds AFTER this handler had already read the stale
        // one. GET /reservations answered {"message":"Unauthenticated."} and the
        // handler burned all three retries on a token that was dead before the
        // first attempt.
        //
        // The refresh-aware getter closes both halves: it renews inside a
        // 30-minute window rather than waiting for expiry, and it takes the
        // refresh lock so it cannot race a concurrent renewal. Hostex's
        // equivalent handler already used its own getValidHostexToken; only
        // Hospitable was reading raw. (Hostaway legitimately reads raw — its
        // API key cannot be refreshed at all.)
        const t = await getValidHospitableToken(user_id)
        if (!t) throw new NonRetriableError('No Hospitable token found — reconnect required')
        return t
      },
      sync: (token, propertyIdMap) => syncHospitableReservations({
        step,
        logger,
        token,
        orgId:           org_id,
        userId:          user_id,
        propertyIdMap,
        lookaheadMonths: RECONCILE_LOOKAHEAD_MONTHS,
        system:          SYSTEM,
        revenueMode:     'new-only',
      }),
    })
  }
)
