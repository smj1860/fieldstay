// lib/inngest/functions/hostaway/reservation-reconcile-handler.ts
// ============================================================================
// Per-connection Hostaway reservation sweep. Dispatched daily by
// hostawayReservationReconcileCron.
//
// Until webhooks land this is not a backstop — it is the ONLY way a change made
// in Hostaway reaches FieldStay after the initial sync. A cancellation, a date
// change or a new booking is invisible here for up to 24 hours, which is the
// same posture OwnerRez shipped with and is worth stating rather than leaving
// to be discovered.
//
// The shell (token, property map, empty-skip, log, report-and-rethrow) is
// shared with Hospitable and Hostex via runProviderReconcile. What stays here
// is what actually differs: the window to sweep and the revenue mode.
//
//   - Reservations only. Properties are not re-fetched; a rename or a new
//     listing arrives on the next initial sync or manual resync. (Manual resync
//     DOES re-read properties — it dispatches integration/hostaway.sync.requested,
//     not this event.)
//   - revenueMode 'new-only'. 'all' would fire one booking/confirmed per
//     confirmed booking per org every day — thousands of guaranteed no-ops.
//
// This sweep does NOT reconcile by absence: it upserts what the window returns
// and never deletes a local booking that the fetch stopped mentioning. Verified
// — runReservationPipeline has no delete pass — and correct for this provider,
// because a Hostaway cancellation arrives as status 'cancelled' on the
// reservation itself, so the state change is carried IN the data rather than by
// its disappearance. The residual gap is a reservation HARD-deleted in Hostaway,
// which lingers locally; that is the better failure than the alternative, which
// on 2026-07-18 deactivated an entire org's crew roster the one time a provider
// fetch returned [] on an error. See unit/guardrails/absence-reconciliation.test.ts.
//
// A connection whose token is gone is a NonRetriableError: the PM must
// reconnect, and burning retries daily against a dead credential only obscures
// the real failures. That matters more for Hostaway than for the OAuth
// providers — its token cannot be refreshed at all (the API key is discarded
// after the one-time exchange), so "gone" here means gone until a human acts.
//
// It does NOT flip the connection to 'error'. For the OAuth providers that is
// integration-token-refresh-handler's job, which owns the reconnect email and
// its dedup flag. Hostaway is not in that cron's scope — see the
// token-expiry task in docs/HOSTAWAY_ENABLEMENT.md — so today nothing emails
// the PM. Adding a send here would give it no dedup and one message per day.
// ============================================================================

import { inngest }              from '@/lib/inngest/client'
import { NonRetriableError }    from 'inngest'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { runProviderReconcile } from '../shared/reconcile-shell'
import { syncHostawayReservations } from './reservation-sync'

const PROVIDER = 'hostaway' as const
const SYSTEM   = 'inngest:hostaway-reservation-reconcile'

/**
 * One month back. Enough to pick up a cancellation or a date change on a stay
 * that has already happened, without re-reading a year of settled history every
 * day.
 *
 * No lookahead constant, unlike Hostex: Hostaway's GET /reservations is bounded
 * by `dateFrom` alone and returns everything after it, so the forward horizon is
 * unlimited by construction. Capping it would create a blind band beyond the cap
 * reachable only by a webhook that does not exist yet.
 */
const RECONCILE_HISTORY_MONTHS = 1

export const hostawayReservationReconcileHandler = inngest.createFunction(
  {
    id:      'hostaway-reservation-reconcile-handler',
    name:    'Hostaway: Reservation Reconcile (per connection)',
    retries: 3,
    concurrency: [
      { limit: 4 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/hostaway.reservation_reconcile.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    return runProviderReconcile({
      step,
      logger,
      provider: PROVIDER,
      label:    'Hostaway',
      userId:   user_id,
      orgId:    org_id,
      system:   SYSTEM,
      readToken: async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw new NonRetriableError('No Hostaway token found — reconnect required')
        return t
      },
      sync: (token, propertyIdMap) => syncHostawayReservations({
        step,
        logger,
        token,
        orgId:         org_id,
        userId:        user_id,
        propertyIdMap,
        fetchMode:     { kind: 'window', historyMonths: RECONCILE_HISTORY_MONTHS },
        system:        SYSTEM,
        revenueMode:   'new-only',
      }),
    })
  }
)
