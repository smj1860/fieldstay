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
// ============================================================

import { inngest }              from '@/lib/inngest/client'
import { NonRetriableError }    from 'inngest'
import { fetchAllRows }         from '@/lib/inngest/paginate'
import { createServiceClient }  from '@/lib/supabase/server'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { reportError }          from '@/lib/observability/report-error'
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

    try {
      const token = await step.run('read-token', async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw new NonRetriableError('No Hospitable token found — reconnect required')
        return t
      })

      // Hospitable property external_id → FieldStay properties.id, read from
      // our own rows. Paginated: this is per-org and properties are plan-
      // capped, but lib/inngest/** reads are bounded on principle — an
      // unbounded one truncates at 1000 with a 200 and no signal, and a
      // truncated map here silently drops every reservation on the missing
      // properties via the unmapped-property guard.
      const propertyIdMap = await step.run('fetch-property-map', async () => {
        const supabase = createServiceClient({ system: SYSTEM })

        const rows = await fetchAllRows<{ id: string; external_id: string | null }>(
          (from, to) => supabase
            .from('properties')
            .select('id, external_id')
            .eq('org_id', org_id)
            .eq('external_source', PROVIDER)
            .eq('is_active', true)
            .not('external_id', 'is', null)
            .order('id', { ascending: true })
            .range(from, to),
          { label: `hospitable-reconcile.properties[org=${org_id}]` },
        )

        const map: Record<string, string> = {}
        for (const r of rows) if (r.external_id) map[r.external_id] = r.id
        return map
      })

      if (!Object.keys(propertyIdMap).length) {
        // Not an error: a connection with no synced properties yet (the
        // initial sync may still be running) has nothing to reconcile.
        logger.info(`[Hospitable:${user_id}] Reconcile skipped — no active Hospitable properties`)
        return { skipped: true, reason: 'no_properties' }
      }

      const { reservationCount, newTurnoverIds } = await syncHospitableReservations({
        step,
        logger,
        token,
        orgId:           org_id,
        userId:          user_id,
        propertyIdMap,
        lookaheadMonths: RECONCILE_LOOKAHEAD_MONTHS,
        system:          SYSTEM,
        revenueMode:     'new-only',
      })

      logger.info(
        `[Hospitable:${user_id}] Reservation reconcile complete — ` +
        `${Object.keys(propertyIdMap).length} properties, ${reservationCount} reservations, ` +
        `${newTurnoverIds.length} new turnovers`
      )

      return {
        properties:   Object.keys(propertyIdMap).length,
        reservations: reservationCount,
        turnovers:    newTurnoverIds.length,
      }
    } catch (err) {
      // Report and rethrow. A reconcile that fails must surface and retry —
      // swallowing it here would recreate the exact silence this whole
      // function exists to end.
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[Hospitable:${user_id}] reservation reconcile failed: ${msg}`)
      reportError(err, { site: 'inngest.hospitable-reservation-reconcile-handler' })
      throw err
    }
  }
)
