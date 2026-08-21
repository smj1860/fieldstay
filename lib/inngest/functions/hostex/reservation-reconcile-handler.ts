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
import { reportError }         from '@/lib/observability/report-error'
import { getValidHostexToken } from '@/lib/integrations/providers/hostex-token'
import { ensureHostexWebhookRegistration } from '@/lib/integrations/providers/hostex-webhook'
import { runProviderReconcile } from '../shared/reconcile-shell'
import { syncHostexReservations } from './reservation-sync'
import { syncHostexReviews } from './reviews-sync'
import { syncHostexStaff } from './staff-sync'

const PROVIDER = 'hostex' as const
const SYSTEM   = 'inngest:hostex-reservation-reconcile'

/**
 * One month back. Enough to pick up a cancellation or a date change on a stay
 * that has already happened, without re-reading a year of settled history
 * every day.
 */
const RECONCILE_HISTORY_MONTHS = 1

/**
 * Reviews sweep further back than reservations — a guest can review weeks
 * after checkout, and a host_reply posted inside Hostex changes an existing
 * row's response_status. Still one legal window (<180 days), so one request
 * per page rather than a chunked backfill.
 */
const RECONCILE_REVIEW_HISTORY_MONTHS = 5

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
      sync: async (token, propertyIdMap) => {
        const result = await syncHostexReservations({
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
        })

        // Reviews ride the same daily pass rather than getting their own cron:
        // they need the same token and the same property map, and Hostex's
        // quota is per-connection, so a second cron would only add a second
        // place for the connection to be resolved.
        await syncHostexReviews({
          step,
          logger,
          token,
          orgId:         org_id,
          userId:        user_id,
          propertyIdMap,
          fetchMode:     { kind: 'window', historyMonths: RECONCILE_REVIEW_HISTORY_MONTHS },
          system:        SYSTEM,
          stepPrefix:    'reconcile',
        })

        // Staff rides the same daily pass. Hostex has no staff webhook, so
        // this is the ONLY way a hire or a departure ever reaches FieldStay.
        await syncHostexStaff({
          step, logger, token,
          orgId:         org_id,
          userId:        user_id,
          system:        SYSTEM,
          stepPrefix:    'reconcile',
          // Same fetch, same two derivations — a property whose cleaning_cost
          // is still null picks one up as soon as Hostex has priced a clean
          // for it.
          propertyIdMap,
        })

        // Re-assert the webhook registration on every pass.
        //
        // It was previously attempted EXACTLY ONCE, in initial-sync's
        // register-webhook step, where a failure is deliberately non-fatal —
        // logged, reported, and then nothing ever tried again. So a connection
        // that hit a 5xx, a throttle, or a momentarily-unset NEXT_PUBLIC_APP_URL
        // during its one attempt degraded permanently to daily-reconcile-only,
        // with a successful initial sync and a green connection to show for it.
        // The registration is also the half of the pairing Hostex can lose from
        // ITS side — deleted in the portal, dropped in a migration — and nothing
        // here would have noticed.
        //
        // Cheap enough to be unconditional: hostexEnsureWebhook is a GET
        // /webhooks that returns early when the URL is already registered, so
        // the steady-state cost is one request per connection per day against a
        // 600/min per-token budget. The URL token is minted once and reused, so
        // this cannot orphan the registration Hostex already holds.
        //
        // Non-fatal for the same reason it is in initial sync: this pass has
        // already imported reservations, reviews and staff, and failing it over
        // a registration would throw all of that away and re-do it tomorrow.
        await step.run('ensure-webhook', async () => {
          try {
            const { attempted, created } = await ensureHostexWebhookRegistration(user_id, token)
            if (created) {
              // Worth a line: on a reconcile pass this means the registration
              // was ABSENT, which is a repair rather than a setup.
              logger.warn(`[Hostex:${user_id}] webhook registration was missing — re-registered`)
            }
            // A summary, never the token — Inngest persists step return values.
            return { attempted, created }
          } catch (err) {
            logger.error(`[Hostex:${user_id}] webhook re-registration failed: ${err instanceof Error ? err.message : String(err)}`)
            reportError(err, { site: 'inngest.hostex-reservation-reconcile.ensure-webhook', orgId: org_id })
            return { attempted: false, created: false }
          }
        })

        return result
      },
    })
  }
)
