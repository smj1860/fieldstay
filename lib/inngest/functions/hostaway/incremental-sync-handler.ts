// lib/inngest/functions/hostaway/incremental-sync-handler.ts
// ============================================================================
// Per-connection hourly incremental sweep. Dispatched (jittered) by
// hostawayIncrementalSyncCron.
//
// Fetches everything CHANGED since this connection's cursor via
// latestActivityStart, runs it through the shared reservation pipeline, then
// advances the cursor. See the cron's header for why this exists instead of
// webhooks.
//
// ── The cursor, and why it is deliberately blunt ────────────────────────────
//
// Hostaway's latestActivityStart takes a DATE (Y-m-d), not a timestamp, so the
// finest window this filter can express is one day. The cursor is therefore a
// date and every hourly run re-reads at least today's changes. That is not
// waste to be optimised away — it is what makes the sweep idempotent under an
// Inngest retry, a clock skew, or a deploy mid-run, and the pipeline's upsert
// is a no-op for a reservation that has not actually changed.
//
// The cursor is stepped back one day rather than set to today, because a
// change landing between the fetch and the cursor write would otherwise fall
// into the gap between two runs and not be seen again until the daily
// reconcile. One day of deliberate overlap costs a re-read; the alternative
// costs a silently missed cancellation.
//
// ── revenueMode ─────────────────────────────────────────────────────────────
//
// 'new-only'. 'all' would fire one booking/confirmed per confirmed booking per
// org EVERY HOUR — thousands of guaranteed no-ops a day, where the daily
// reconcile's same choice was already made for the same reason.
// ============================================================================

import { inngest }              from '@/lib/inngest/client'
import { NonRetriableError }    from 'inngest'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { createServiceClient }  from '@/lib/supabase/server'
import { unwrap }               from '@/lib/supabase/unwrap'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { syncHostawayReservations } from './reservation-sync'
import { isProviderAuthFailure } from '@/lib/integrations/connection-revoked'
import { revokeAndNotify } from '@/lib/inngest/functions/shared/revoke-and-notify'

const PROVIDER = 'hostaway' as const
const SYSTEM   = 'inngest:hostaway-incremental-sync'

/**
 * How far back a connection with no cursor yet starts.
 *
 * Small on purpose: a fresh connection has just had its 12-month initial sync,
 * and a connection whose cursor was lost is caught up by the daily reconcile
 * anyway. Sweeping a wide window here would turn every first hourly run into a
 * second full backfill.
 */
const COLD_START_DAYS = 2

/** One day of deliberate overlap — see the header. */
const CURSOR_OVERLAP_DAYS = 1

function isoDateDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

export const hostawayIncrementalSyncHandler = inngest.createFunction(
  {
    id:      'hostaway-incremental-sync-handler',
    name:    'Hostaway: Incremental Sync (per connection)',
    retries: 3,
    concurrency: [
      { limit: 4 },
      // One run per org at a time. Without this an hourly sweep that overran
      // its hour would overlap its own successor on the same connection, and
      // both would be writing the same booking rows.
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/hostaway.incremental_sync.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    // The whole sweep is wrapped, not just the first fetch: Hostaway's API key
    // cannot be refreshed, so once it stops being accepted every step below
    // fails the same way, and this runs HOURLY. Catching outside the steps lets
    // Inngest exhaust its retries first, so a transient 401 cannot revoke a
    // working connection.
    try {
    const prepared = await step.run('read-cursor-and-properties', async () => {
      const token = await readIntegrationToken(user_id, PROVIDER)
      // Retrying cannot conjure a token — only reconnecting can — and Hostaway's
      // API key cannot be refreshed at all, so "gone" here means gone until a
      // human acts. Burning retries hourly against a dead credential only
      // obscures the real failures.
      if (!token) throw new NonRetriableError('No Hostaway token found — reconnect required')

      const supabase = createServiceClient({ system: SYSTEM })

      const connRes = await supabase
        .from('integration_connections')
        .select('metadata')
        .eq('user_id',     user_id)
        .eq('provider_id', PROVIDER)
        .maybeSingle()

      const conn = unwrap(connRes, {
        site: 'inngest.hostaway-incremental.connection', orgId: org_id,
      })

      const metadata = (conn?.metadata ?? {}) as Record<string, unknown>
      const cursor   = typeof metadata.incremental_cursor === 'string'
        ? metadata.incremental_cursor
        : isoDateDaysAgo(COLD_START_DAYS)

      // Bounded by the org's property count (plan-capped), not by time.
      const propsRes = await supabase
        .from('properties')
        .select('id, external_id')
        .eq('org_id',          org_id)
        .eq('external_source', PROVIDER)
        .not('external_id', 'is', null)
        .limit(1000)

      const properties = unwrap(propsRes, {
        site: 'inngest.hostaway-incremental.properties', orgId: org_id,
      }) ?? []

      const propertyIdMap: Record<string, string> = {}
      for (const p of properties as { id: string; external_id: string }[]) {
        propertyIdMap[p.external_id] = p.id
      }

      // The token is deliberately NOT returned. A step's return value is
      // persisted by Inngest and replayed on every retry — so returning it both
      // parks a credential in third-party storage and guarantees that a retry
      // spends the same one the first attempt had. See the "credentials are not
      // step state" note in lib/integrations/providers/hospitable-token.ts.
      return { cursor, propertyIdMap }
    })

    if (!Object.keys(prepared.propertyIdMap).length) {
      logger.info(`[Hostaway:${user_id}] Incremental sweep skipped — no synced properties yet`)
      return { skipped: true, reason: 'no_properties' }
    }

    const result = await syncHostawayReservations({
      step,
      logger,
      getToken:      async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw new NonRetriableError('No Hostaway token found — reconnect required')
        return t
      },
      orgId:         org_id,
      userId:        user_id,
      propertyIdMap: prepared.propertyIdMap,
      fetchMode:     { kind: 'activitySince', since: prepared.cursor },
      system:        SYSTEM,
      revenueMode:   'new-only',
    })

    // Cursor advances ONLY after the pipeline succeeded. Writing it before —
    // or in the same step as the fetch — would skip a window whose upserts
    // then failed, and nothing would re-read it until the daily reconcile.
    await step.run('advance-cursor', async () => {
      await mergeIntegrationConnectionMetadata({
        userId:     user_id,
        providerId: PROVIDER,
        patch: {
          incremental_cursor:      isoDateDaysAgo(CURSOR_OVERLAP_DAYS),
          last_incremental_sync_at: new Date().toISOString(),
        },
      })
    })

    logger.info(
      `[Hostaway:${user_id}] Incremental sweep: ${result.reservationCount} reservations since ${prepared.cursor}`
    )

    return {
      reservations:   result.reservationCount,
      newTurnoverIds: result.newTurnoverIds.length,
      since:          prepared.cursor,
    }
    } catch (err) {
      if (!isProviderAuthFailure(err)) throw err

      // Decision in a step, send at the top level — see
      // lib/integrations/connection-revoked.ts.
      await revokeAndNotify({
        step, logger, userId: user_id, orgId: org_id, err,
        providerId: PROVIDER, providerLabel: 'Hostaway',
        system: SYSTEM, fnId: 'hostaway-incremental-sync-handler',
      })

      return { reservations: 0, newTurnoverIds: 0, since: null, revoked: true }
    }
  }
)
