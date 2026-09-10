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
import { reconnectRequired }    from '@/lib/inngest/reconnect-required'
import { reportError }          from '@/lib/observability/report-error'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { fetchProviderPropertyIdMap } from '../shared/reservation-pipeline'
import { syncLodgifyReservations, type LodgifyFetchMode } from './reservation-sync'

const PROVIDER = 'lodgify' as const
const SYSTEM   = 'inngest:lodgify-webhook-handler'

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
    // touches the same properties. A modest platform cap keeps a busy account
    // from monopolising function capacity.
    concurrency: [
      { limit: 10 },
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
      reportError(err, { site: 'inngest.lodgify-webhook-handler', orgId: org_id })
      throw err
    }
  }
)
