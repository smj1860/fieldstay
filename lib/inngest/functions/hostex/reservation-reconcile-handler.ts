// lib/inngest/functions/hostex/reservation-reconcile-handler.ts
// ============================================================================
// Per-connection Hostex reservation sync. Dispatched by
// hostexReservationReconcileCron (daily) and by the Settings "Trigger Resync"
// action.
//
// Runs the SAME pipeline as the initial sync's reservation half, via the
// shared syncHostexReservations() — not a second copy of the upsert, the two
// silent-drop guards and the turnover regeneration.
//
// Differences from hostexInitialSync, all intentional:
//
//   1. Reservations only — properties are not re-fetched. A property rename or
//      a newly-added listing arrives on the next initial sync or manual
//      resync; re-reading every property daily buys little and costs a request
//      per connection per day. (Manual resync DOES re-fetch properties: it
//      dispatches integration/hostex.connected, not this event.)
//
//   2. The property map is read from OUR database, not from Hostex.
//
//   3. revenueMode 'new-only' — 'all' would fire one booking/confirmed per
//      confirmed booking per org every day, thousands of guaranteed no-ops.
//
//   4. A short history window. The initial sync pulls 12 months back to build
//      the P&L; a daily pass only needs enough overlap to catch a stay that
//      was modified or cancelled after the fact.
//
// A connection whose token is gone is a NonRetriableError: the PM must
// reconnect, and burning retries daily against a dead credential only obscures
// the real failures. It does NOT flip the connection to 'error' — that is
// integration-token-refresh-handler's job, which owns the reconnect email and
// its dedup flag, and a daily cron racing it would send duplicates.
// ============================================================================

import { inngest }             from '@/lib/inngest/client'
import { NonRetriableError }   from 'inngest'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'
import { getValidHostexToken } from '@/lib/integrations/providers/hostex-token'
import { syncHostexReservations } from './reservation-sync'

const PROVIDER = 'hostex'
const SYSTEM   = 'inngest:hostex-reservation-reconcile'

/**
 * One month back. Enough to pick up a cancellation or a date change on a stay
 * that has already happened, without re-reading a year of settled history
 * every day.
 */
const RECONCILE_HISTORY_MONTHS = 1

/**
 * Six months forward, matching INITIAL_SYNC_LOOKAHEAD_MONTHS. A reconcile that
 * swept less than the initial sync would leave a permanent blind band beyond
 * its own horizon — and with no webhook path, nothing else would ever fill it.
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

    try {
      const token = await step.run('read-token', async () => {
        const t = await getValidHostexToken(user_id)
        if (!t) throw new NonRetriableError('No Hostex token found — reconnect required')
        return t
      })

      // Hostex property id → FieldStay properties.id, from our own rows.
      // Paginated on principle: a truncated map here does not shorten a list,
      // it silently drops every reservation on the missing properties via the
      // unmapped-property guard in the pipeline.
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
          { label: `hostex-reconcile.properties[org=${org_id}]` },
        )

        const map: Record<string, string> = {}
        for (const r of rows) if (r.external_id) map[r.external_id] = r.id
        return map
      })

      if (!Object.keys(propertyIdMap).length) {
        // Not an error: a connection whose initial sync has not finished (or
        // whose Hostex account has no properties) has nothing to reconcile.
        logger.info(`[Hostex:${user_id}] Reconcile skipped — no active Hostex properties`)
        return { skipped: true, reason: 'no_properties' }
      }

      const { reservationCount, newTurnoverIds } = await syncHostexReservations({
        step,
        logger,
        token,
        orgId:           org_id,
        userId:          user_id,
        propertyIdMap,
        historyMonths:   RECONCILE_HISTORY_MONTHS,
        lookaheadMonths: RECONCILE_LOOKAHEAD_MONTHS,
        system:          SYSTEM,
        revenueMode:     'new-only',
      })

      logger.info(
        `[Hostex:${user_id}] Reservation reconcile complete — ` +
        `${Object.keys(propertyIdMap).length} properties, ${reservationCount} reservations, ` +
        `${newTurnoverIds.length} new turnovers`
      )

      return {
        properties:   Object.keys(propertyIdMap).length,
        reservations: reservationCount,
        turnovers:    newTurnoverIds.length,
      }
    } catch (err) {
      // Report and rethrow. A reconcile that fails silently is exactly the
      // failure this function exists to prevent — with no webhook path, this
      // is the only thing keeping a Hostex org's bookings current.
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[Hostex:${user_id}] reservation reconcile failed: ${msg}`)
      reportError(err, { site: 'inngest.hostex-reservation-reconcile-handler' })
      throw err
    }
  }
)
