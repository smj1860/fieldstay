// lib/inngest/functions/lodgify/webhook-handler.ts
// ============================================================================
// Processes one Lodgify webhook delivery that has already been authenticated
// by app/api/webhooks/lodgify/[token].
//
// THE DELIVERY IS A PING, NEVER A RECORD. The route reads at most a booking id
// out of the body; this function re-reads that booking from Lodgify with our
// own API key and runs the result through the same pipeline the daily sweep
// uses. Nothing a delivery said about dates, status, guest or money reaches a
// database — which is what makes an unsigned webhook (Lodgify documents no
// signature; see lodgify.ts's header) safe to act on at all.
//
// TWO MODES, and the second is the point:
//
//   booking_id present → re-read that one booking.
//   booking_id null    → sweep a SHORT RECENT WINDOW for the connection.
//
// The null case is what happens when the payload was unparseable, oversized,
// or spelled its id field differently than lodgify.types.ts guesses. Because
// the response shapes here are unverified, that is a real possibility rather
// than a theoretical one — and the fallback turns "our guess was wrong" into
// "we did slightly more work" instead of "the change was lost".
//
// A delivery for a property we have never imported is a SKIP, not a failure:
// the property was added in Lodgify after our last property sync, and its
// bookings arrive once that runs. Retrying would not conjure the property.
// ============================================================================

import { inngest }              from '@/lib/inngest/client'
import { reconnectRequired, isReconnectRequired } from '@/lib/inngest/reconnect-required'
import { reportError }          from '@/lib/observability/report-error'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { isLodgifyAuthFailure } from '@/lib/integrations/providers/lodgify-api'
import { isProviderAuthFailure } from '@/lib/integrations/connection-revoked'
import { fetchProviderPropertyIdMap } from '../shared/reservation-pipeline'
import { syncLodgifyReservations, type LodgifyFetchMode } from './reservation-sync'

const PROVIDER = 'lodgify' as const
const SYSTEM   = 'inngest:lodgify-webhook-handler'

/**
 * A terminal, already-known-dead connection.
 *
 * Lodgify has no revocation webhook — no way at all for it to tell us the PM
 * rotated their key — so it keeps pushing events to a still-registered URL
 * until the daily reconcile catches this same condition and revokes the
 * connection. Reporting every one of those deliveries is one Sentry event per
 * webhook, potentially many per hour for an active listing, for a condition
 * already being handled on its own daily cadence rather than a new fault.
 *
 * Deliberately narrower than a blanket `err instanceof NonRetriableError`.
 * TERMINAL_STATUSES in lodgify-api.ts wraps 400, 404 (on list endpoints,
 * where no entityId narrows it to ProviderEntityGoneError), 405, 409 and 422
 * as NonRetriableError too — none of those are the connection being dead, and
 * lodgifyReservationReconcileHandler's OWN dead-connection check (the thing
 * this function's comment says "owns revoking this connection") does not
 * recognise them either, so a blanket match here suppressed this function's
 * inline, orgId-tagged reportError() call for all of them on the belief that
 * reconcile would revoke the connection and cover it — it never does, for
 * anything but a genuine auth failure. (Inngest's own dead-letter handler
 * still reports every terminal failure generically; what a blanket match
 * loses is the orgId-scoped context this handler's own reportError call
 * would have attached, and it mislabels an unrelated terminal error as an
 * already-understood dead connection in the log line below.)
 *
 * `isReconnectRequired` is kept as its own check rather than folded into
 * `isLodgifyAuthFailure`: readToken's reconnectRequired() (no key in Vault at
 * all) is a real "nothing to sync, PM must reconnect" case with no HTTP
 * status behind it, so it cannot be typed as a ProviderAuthError — but it is
 * exactly as terminal, and it is what the marker exists to identify.
 */
export function isDeadLodgifyConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return isLodgifyAuthFailure(err) || isProviderAuthFailure(err) || isReconnectRequired(message)
}

/**
 * The fallback sweep's window, in months, when a delivery named no booking we
 * could recognise.
 *
 * One month back and one forward. Deliberately narrow: this runs per delivery,
 * so a wide window would turn every unrecognised payload into a full backfill
 * against a rate limit whose real ceiling is unverified. A change outside this
 * band is still caught by the daily reconcile's twelve-times-wider sweep.
 */
const FALLBACK_HISTORY_MONTHS   = 1
const FALLBACK_LOOKAHEAD_MONTHS = 1

export const lodgifyWebhookHandler = inngest.createFunction(
  {
    id:      'lodgify-webhook-handler',
    name:    'Lodgify: Webhook Delivery',
    retries: 3,
    // Serialized per connection, not per org: two deliveries for the same
    // connection racing would run two pipelines whose turnover regeneration
    // touches the same properties. The platform cap keeps a busy account from
    // monopolising function capacity — 40, matching the Hostex equivalent
    // after the 2026-09-16 high-scale audit: the per-connection key only
    // serialises each connection against ITSELF, so a low platform cap queues
    // unrelated orgs behind each other for no reason.
    concurrency: [
      { limit: 40 },
      { limit: 1, key: 'event.data.user_id' },
    ],
    // One booking's state is worth reading at most once per few seconds. A
    // single guest edit can produce several deliveries naming the SAME booking
    // within moments (Lodgify publishes booking_change and
    // booking_status_change separately), each of which would otherwise cost a
    // full read + upsert + turnover regeneration to reach the identical end
    // state.
    //
    // Keyed on the booking id INCLUDING the null case: collapsing a burst of
    // unrecognised deliveries into one window sweep is exactly the desired
    // behaviour, since a second sweep of the same window would find the same
    // rows.
    debounce: {
      key:    'event.data.user_id + ":" + event.data.booking_id',
      period: '10s',
    },
  },
  { event: 'integration/lodgify.webhook.received' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id, event: lodgifyEvent, booking_id } = event.data

    try {
      // A GETTER, invoked inside each step that spends it — see the
      // "credentials are not step state" note in
      // lib/integrations/providers/hospitable-token.ts.
      const getToken = async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw reconnectRequired('No Lodgify API key found — reconnect required')
        return t
      }

      const propertyIdMap = await step.run('fetch-property-map', () =>
        fetchProviderPropertyIdMap(org_id, PROVIDER, SYSTEM))

      if (!Object.keys(propertyIdMap).length) {
        logger.info(`[Lodgify:${user_id}] ${lodgifyEvent || 'delivery'} but no active Lodgify properties — skipping`)
        return { skipped: true, reason: 'no_properties' }
      }

      const fetchMode: LodgifyFetchMode = booking_id
        ? { kind: 'ids', bookingIds: [booking_id] }
        : {
            kind:            'window',
            historyMonths:   FALLBACK_HISTORY_MONTHS,
            lookaheadMonths: FALLBACK_LOOKAHEAD_MONTHS,
          }

      if (!booking_id) {
        // Worth a log line rather than silence: a connection whose deliveries
        // ALWAYS land here means the id field is spelled differently than
        // extractBookingId guesses, which is a one-line fix once someone can
        // see it happening.
        logger.info(`[Lodgify:${user_id}] delivery named no recognizable booking — sweeping the recent window instead`)
      }

      const { reservationCount, newTurnoverIds } = await syncLodgifyReservations({
        step,
        logger,
        getToken,
        orgId:         org_id,
        userId:        user_id,
        // The whole map, not a narrowed one: the delivery did not tell us
        // which property this booking belongs to (and would not be believed if
        // it had), so the property is whatever the RE-READ booking names.
        // Anything outside this org's imported set is dropped by the pipeline's
        // own unknown-property guard.
        propertyIdMap,
        fetchMode,
        system:      SYSTEM,
        // 'all', not 'new-only': a booking_change for a stay we already hold
        // must still be able to post revenue that failed the first time, and
        // the post is idempotent so a repeat costs nothing.
        revenueMode: 'all',
      })

      logger.info(
        `[Lodgify:${user_id}] ${lodgifyEvent || 'delivery'} processed — ` +
        `${reservationCount} booking(s), ${newTurnoverIds.length} new turnover(s)`
      )

      return { reservations: reservationCount, turnovers: newTurnoverIds.length }
    } catch (err) {
      // Report and rethrow. Whether Lodgify redelivers a failed webhook is
      // unconfirmed, so this has to assume it does not — swallowing the
      // failure would make the loss invisible until the next daily sweep.
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[Lodgify:${user_id}] webhook handling failed (booking ${booking_id ?? 'unknown'}): ${msg}`)

      if (isDeadLodgifyConnectionError(err)) {
        // Logged, not reported — see isDeadLodgifyConnectionError. The daily
        // reconcile owns revoking this connection and telling the PM.
        logger.warn(`[Lodgify:${user_id}] connection appears dead — suppressing duplicate report, awaiting reconcile revoke`)
        throw err
      }

      reportError(err, { site: 'inngest.lodgify-webhook-handler', orgId: org_id })
      throw err
    }
  }
)
