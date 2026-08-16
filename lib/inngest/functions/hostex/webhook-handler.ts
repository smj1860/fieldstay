// lib/inngest/functions/hostex/webhook-handler.ts
// ============================================================================
// Processes one authenticated Hostex webhook delivery.
//
// Everything the route could not afford to do inline. Hostex allows 3 seconds
// to acknowledge and NEVER retries, so app/api/webhooks/hostex/[token] does
// only resolve → authenticate → enqueue, and the actual work lands here.
//
// Hostex's delivery is a PING, not a record — its own guidance is that "the
// payload only confirms THAT the reservation changed" — so this re-reads the
// reservation from the API and runs it through the same pipeline the sweeps
// use, in 'codes' mode. No second copy of the upsert, the guards, the revenue
// post or the turnover regeneration.
//
// A delivery for an unknown property is a SKIP, not a failure: the property
// was added in Hostex after our last property sync, and reservations for it
// arrive once that runs. Retrying would not conjure the property.
// ============================================================================

import { inngest }           from '@/lib/inngest/client'
import { NonRetriableError } from 'inngest'
import { reportError }       from '@/lib/observability/report-error'
import { getValidHostexToken } from '@/lib/integrations/providers/hostex-token'
import { fetchProviderPropertyIdMap } from '../shared/reservation-pipeline'
import { syncHostexReservations } from './reservation-sync'

const PROVIDER = 'hostex' as const
const SYSTEM   = 'inngest:hostex-webhook-handler'

export const hostexWebhookHandler = inngest.createFunction(
  {
    id:      'hostex-webhook-handler',
    name:    'Hostex: Webhook Delivery',
    retries: 3,
    // Serialized per connection, not per org: two deliveries for the same
    // connection racing would run two pipelines whose turnover regeneration
    // touches the same properties. A modest platform cap keeps a busy account
    // from monopolising function capacity.
    concurrency: [
      { limit: 10 },
      { limit: 1, key: 'event.data.user_id' },
    ],
    // One reservation's state is worth reading at most once per few seconds.
    // Hostex fires reservation_updated per sub_event, so a single guest edit
    // can produce several deliveries naming the SAME reservation_code within
    // moments — each would otherwise cost a full read + upsert + turnover
    // regeneration to arrive at the identical end state.
    debounce: {
      key:    'event.data.user_id + ":" + event.data.reservation_code',
      period: '10s',
    },
  },
  { event: 'integration/hostex.webhook.received' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id, event: hostexEvent, reservation_code, property_id } = event.data

    try {
      const token = await step.run('read-token', async () => {
        const t = await getValidHostexToken(user_id)
        if (!t) throw new NonRetriableError('No Hostex token found — reconnect required')
        return t
      })

      const propertyIdMap = await step.run('fetch-property-map', () =>
        fetchProviderPropertyIdMap(org_id, PROVIDER, SYSTEM))

      // Narrow the map to the property this delivery named, when it named one.
      // Two things depend on it: the pipeline regenerates turnovers for every
      // property in the map, and a whole-portfolio regeneration on every
      // webhook would be wildly disproportionate to one changed booking.
      const scopedMap = property_id && propertyIdMap[property_id]
        ? { [property_id]: propertyIdMap[property_id] }
        : propertyIdMap

      if (property_id && !propertyIdMap[property_id]) {
        // Not an error — see the header. The daily reconcile picks this up
        // once the property exists.
        logger.info(
          `[Hostex:${user_id}] ${hostexEvent} for unknown property ${property_id} — ` +
          `skipping until the next property sync`
        )
        return { skipped: true, reason: 'unknown_property' }
      }

      if (!Object.keys(scopedMap).length) {
        logger.info(`[Hostex:${user_id}] ${hostexEvent} but no active Hostex properties — skipping`)
        return { skipped: true, reason: 'no_properties' }
      }

      const { reservationCount, newTurnoverIds } = await syncHostexReservations({
        step,
        logger,
        token,
        orgId:         org_id,
        userId:        user_id,
        propertyIdMap: scopedMap,
        fetchMode:     { kind: 'codes', reservationCodes: [reservation_code] },
        system:        SYSTEM,
        // 'all', not 'new-only': a reservation_updated for a stay we already
        // hold must still be able to post revenue that failed the first time,
        // and the post is idempotent so a repeat costs nothing.
        revenueMode:   'all',
      })

      logger.info(
        `[Hostex:${user_id}] ${hostexEvent} ${reservation_code} processed — ` +
        `${reservationCount} booking(s), ${newTurnoverIds.length} new turnover(s)`
      )

      return { reservations: reservationCount, turnovers: newTurnoverIds.length }
    } catch (err) {
      // Report and rethrow. Hostex does not redeliver, so a failure here is
      // only recoverable by an Inngest retry or by tomorrow's reconcile —
      // swallowing it would make the loss invisible.
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[Hostex:${user_id}] webhook handling failed for ${reservation_code}: ${msg}`)
      reportError(err, { site: 'inngest.hostex-webhook-handler', orgId: org_id })
      throw err
    }
  }
)
