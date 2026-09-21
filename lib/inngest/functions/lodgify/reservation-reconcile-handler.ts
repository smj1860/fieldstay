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
import { reportError }          from '@/lib/observability/report-error'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { ensureLodgifyWebhookRegistration } from '@/lib/integrations/providers/lodgify-webhook'
import { isLodgifyAuthFailure } from '@/lib/integrations/providers/lodgify-api'
import { isProviderAuthFailure } from '@/lib/integrations/connection-revoked'
import { revokeAndNotify } from '@/lib/inngest/functions/shared/revoke-and-notify'
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
    // Platform-wide ceiling of 25, matching the Hostex equivalent after the
    // 2026-09-16 high-scale audit. The daily cron dispatches one event per
    // active connection; at 4 in flight a large fan-out cannot drain within
    // 24h before the NEXT day's cron dispatches on top of it — a backlog that
    // only grows.
    concurrency: [
      { limit: 25 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/lodgify.reservation_reconcile.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    try {
      return await runProviderReconcile({
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
        sync: async (getToken, propertyIdMap) => {
          const result = await syncLodgifyReservations({
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
          })

          // Re-assert the webhook registration on every pass.
          //
          // Registration was previously attempted EXACTLY ONCE, in initial
          // sync's register-webhook step, where a failure is deliberately
          // non-fatal — logged, reported, and then nothing ever tried again.
          // So a connection that hit a 5xx or a momentarily-unset
          // NEXT_PUBLIC_APP_URL during its one attempt degraded permanently to
          // daily-reconcile-only, with a green connection to show for it. The
          // registration is also the half of the pairing LODGIFY can lose from
          // its side — deleted in their portal — and nothing here would notice.
          //
          // It matters more for Lodgify than for Hostex: registration is gated
          // on LODGIFY_WEBHOOKS_ENABLED, so while that flag is off this step
          // no-ops on every pass, and the day it is turned on EVERY existing
          // connection registers itself on its next daily run. Without this,
          // flipping the flag would reach only orgs that connect or resync
          // afterwards — the ones already live would stay on daily sync
          // forever, which is precisely the population the flag was held off
          // for.
          //
          // Non-fatal, for the same reason it is in initial sync: this pass has
          // already imported bookings, and failing it over a registration would
          // throw that away and re-do it tomorrow.
          await step.run('ensure-webhook', async () => {
            try {
              const { attempted, created, reason } = await ensureLodgifyWebhookRegistration(user_id, await getToken())
              if (created > 0) {
                // Worth a line: on a reconcile pass this means the registration
                // was ABSENT, which is a repair rather than a setup.
                logger.warn(`[Lodgify:${user_id}] webhook registration was missing — re-registered ${created} event(s)`)
              }
              // A summary, never the token — Inngest persists step return values.
              return { attempted, created, reason: reason ?? null }
            } catch (err) {
              logger.error(`[Lodgify:${user_id}] webhook re-registration failed: ${err instanceof Error ? err.message : String(err)}`)
              reportError(err, { site: 'inngest.lodgify-reservation-reconcile.ensure-webhook', orgId: org_id })
              return { attempted: false, created: 0, reason: 'failed' }
            }
          })

          return result
        },
      })
    } catch (err) {
      // An API key the PM rotated or deleted in Lodgify is the single most
      // likely way this connection dies, and Lodgify has no revocation webhook
      // (nor any revocation endpoint at all) to tell us — so this daily pass is
      // the ONLY thing that can ever notice. Without this branch the connection
      // would sit green in Settings while every sync failed, which is the exact
      // silence the OwnerRez connections sat in for three weeks.
      //
      // Caught OUTSIDE the runner's steps so Inngest exhausts its retries
      // first: a transient 401 must not revoke a working connection.
      if (!isLodgifyAuthFailure(err) && !isProviderAuthFailure(err)) throw err

      // Decision in a step, send at the top level — see
      // lib/integrations/connection-revoked.ts.
      await revokeAndNotify({
        step, logger, userId: user_id, orgId: org_id, err,
        providerId: PROVIDER, providerLabel: 'Lodgify',
        system: SYSTEM, fnId: 'lodgify-reservation-reconcile-handler',
      })

      return { revoked: true }
    }
  }
)
