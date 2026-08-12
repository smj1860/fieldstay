/**
 * OwnerRez Incremental Sync
 *
 * Two functions:
 *
 * 1. ownerRezIncrementalSync — DISPATCHER. Triggered by:
 *     - Inngest cron:  hourly (0 * * * *) — reliability backstop, sweeps
 *                      every active connection
 *     - Webhook event: integration/ownerrez.sync.requested — scoped to the
 *                      one connection the webhook belongs to when
 *                      ownerrez.ts's handleWebhookEvent resolved it (falls
 *                      back to a full sweep when it couldn't)
 *     - Manual event:  ownerrez/sync.now.requested — always scoped to the
 *                      PM's own connection
 *    It only finds connections and fans out one
 *    `ownerrez/connection.sync.requested` event per connection.
 *
 * 2. ownerRezConnectionSync — PER-CONNECTION HANDLER. Does the actual work
 *    for one connection under its own concurrency cap and retry policy.
 *
 * Why fan-out (see FUTURE_REMEDIATION.md's OwnerRez scaling note): the
 * previous shape looped every connection serially inside one invocation.
 * A RateLimitError from the shared-IP budget broke the WHOLE tick — every
 * connection after the one that tripped it was parked until the next
 * hourly cron. With per-connection runs, a rate-limited connection retries
 * alone with Inngest's backoff (resuming as soon as the 5-minute budget
 * window rolls) and no other tenant is affected. Fair-share enforcement
 * lives in ownerrez-api.ts's checkAndIncrementRequestBudget, which caps a
 * single connection to half the budget under contention.
 *
 * The per-connection new-property diff (a full getProperties() call) used
 * to run every tick for every connection — 100+ requests/hour of pure
 * diffing at 100 connections. New-property discovery is now webhook-primary:
 * ownerrez.ts routes property entity_insert/entity_create webhooks into the
 * scoped sync path (scoped runs always request the diff), so a property
 * added in OwnerRez is discovered within moments. The hourly cron only
 * requests the diff once a day (NEW_PROPERTY_DIFF_UTC_HOUR) as a
 * missed-webhook backstop; manual "Resync" clicks also always request it.
 *
 * TODO(CLAUDE_55_5 Task 7): This function does not currently handle OwnerRez
 * property entity_update webhooks — it only fetches bookings via since_utc.
 * Once property-level webhook handling exists here, add a getPropertyDetail()
 * call (and the guidebook-config patch from initial-sync.ts's
 * fetch-property-details/sync-guidebook-configs-from-property steps) for the
 * specific property that was updated, scoped per the patch's
 * "Do not add webhook handling that isn't already scoped" instruction.
 */

import { inngest }                      from '@/lib/inngest/client'
import { fetchAllRows, SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'
import { NonRetriableError }            from 'inngest'
import type { GetStepTools }            from 'inngest'
import { createServiceClient }          from '@/lib/supabase/server'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { OwnerRezApiClient }  from '@/lib/integrations/providers/ownerrez-api'
import { getRedis, upstashConfigured } from '@/lib/redis'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import { logAuditEvent }                from '@/lib/audit'
import { reportError }                  from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { createPmNotifications, type CreatePmNotificationInput } from '@/lib/inngest/helpers'
import { findMaintenanceCandidatesForWindow } from '@/lib/maintenance/vacancy-suggestions'
import { createGuidebookPropertyConfigsForProperties } from '@/lib/guidebook/sync'
import { seedPresentAssetsFromAmenities } from '@/lib/asset-discovery/seed-from-amenities'
import {
  buildOwnerRezBookingRow,
  partitionMappedBookingRows,
  selectOwnerRezBookingsToPostRevenue,
} from '@/lib/integrations/providers/ownerrez'
import { upsertBookingsReturningIds } from './upsert-bookings'
import type { MappedOwnerRezBookingRow } from '@/lib/integrations/providers/ownerrez'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { unwrap, unwrapList, isRealQueryError } from '@/lib/supabase/unwrap'

const PROVIDER = 'ownerrez'

const CIRCUIT_THRESHOLD = 10

// ── Circuit breaker — PER CONNECTION ────────────────────────────────────────
//
// The breaker's whole job is to stop hammering a failing OwnerRez API. It
// used to increment inside `catch { /* non-fatal */ }`, which meant that
// during a Redis outage — exactly when things are already going wrong — the
// counter never moved, the breaker never opened, and every tick kept
// dispatching connection syncs into a degraded API. CLAUDE.md makes the same
// call for the SMS spend ceiling: a protective limit must not disappear
// during an outage.
//
// So the breaker fails CLOSED, with a per-instance in-memory counter as the
// degraded fallback. A serverless instance is short-lived and there are many
// of them, so this is weaker than the shared Redis counter — but it still
// stops a single hot instance from looping against a dead API, and it is
// strictly better than "no breaker at all". Every Redis failure is logged
// with context and reported, never swallowed.
//
// The key is keyed BY CONNECTION. It used to be one global
// 'ownerrez:circuit:consecutive_failures' shared by every tenant, which was
// wrong in both directions at once:
//
//   • recordCircuitFailure() is called from handleConnectionSyncFailure — a
//     PER-CONNECTION handler. One org with a bad token incremented the shared
//     counter every hour, and at the threshold the DISPATCHER returned early,
//     so no org synced at all for up to the key's 30-minute TTL. One
//     customer's expired credentials halted OwnerRez sync platform-wide.
//   • resetCircuitBreaker() does redis.del() on ANY connection's success. With
//     connections fanned out concurrently, one healthy org wiped the failures
//     nine failing orgs had just recorded — so a genuinely degraded-but-not-
//     dead API (some calls succeeding) could never trip the breaker, which is
//     precisely the case it exists for.
//
// Per-connection keys give the same protection with neither coupling: if the
// API is truly down, every connection fails and every connection's breaker
// opens independently. It also removes a real race — `del` on success and
// `incr` on failure were hitting one key from parallel runs.
const circuitKey = (connectionId: string) => `ownerrez:circuit:${connectionId}`

const localCircuitFailures = new Map<string, number>()

async function isCircuitOpen(
  logger: { warn: (msg: string) => void },
  connectionId: string,
): Promise<boolean> {
  const local = localCircuitFailures.get(connectionId) ?? 0

  // "Upstash is not configured here" is not the same event as "Redis is down",
  // and only the second one deserves the catch below. Upstash's free plan is
  // production-only, so every preview deploy hits this — and calling anyway
  // cost a doomed fetch plus one Sentry report per connection per tick, which
  // is where CUSHION-D/E/H's 590 events came from. The degraded behaviour is
  // identical either way (the in-memory counter is the documented fallback);
  // only the noise differs.
  if (!upstashConfigured()) return local >= CIRCUIT_THRESHOLD

  try {
    const failCount = await getRedis().get<number>(circuitKey(connectionId)) ?? 0
    return failCount >= CIRCUIT_THRESHOLD
  } catch (err) {
    logger.warn(
      `[OwnerRez] Circuit-breaker state unreadable (Redis error) — falling back to the ` +
      `in-memory failure count (${local}/${CIRCUIT_THRESHOLD}) for connection ${connectionId}: ` +
      `${err instanceof Error ? err.message : String(err)}`
    )
    reportError(err, {
      site:  'inngest.ownerrez-incremental-sync.circuit_breaker_read',
      extra: { connection_id: connectionId, localCircuitFailures: local },
    })
    return local >= CIRCUIT_THRESHOLD
  }
}

async function recordCircuitFailure(
  logger: { warn: (msg: string) => void },
  connectionId: string,
): Promise<void> {
  const local = (localCircuitFailures.get(connectionId) ?? 0) + 1
  localCircuitFailures.set(connectionId, local)

  // The in-memory counter above is the protection when there is no shared one;
  // it has already been advanced, so there is nothing left to do here.
  if (!upstashConfigured()) return

  try {
    const redis    = getRedis()
    const newCount = await redis.incr(circuitKey(connectionId))
    if (newCount === 1) await redis.expire(circuitKey(connectionId), 30 * 60)
  } catch (err) {
    logger.warn(
      `[OwnerRez] Could not record circuit-breaker failure in Redis — the shared counter ` +
      `is not advancing for connection ${connectionId}; only the in-memory fallback ` +
      `(${local}/${CIRCUIT_THRESHOLD}) is protecting the API: ` +
      `${err instanceof Error ? err.message : String(err)}`
    )
    reportError(err, {
      site:  'inngest.ownerrez-incremental-sync.circuit_breaker_increment',
      extra: { connection_id: connectionId, localCircuitFailures: local },
    })
  }
}

async function resetCircuitBreaker(
  logger: { warn: (msg: string) => void },
  connectionId: string,
): Promise<void> {
  localCircuitFailures.delete(connectionId)

  if (!upstashConfigured()) return

  try {
    await getRedis().del(circuitKey(connectionId))
  } catch (err) {
    // Failing to CLEAR the breaker errs toward staying closed — safe, but
    // it can keep syncs paused for up to the key's 30-minute TTL, so say so.
    logger.warn(
      `[OwnerRez] Could not reset the circuit breaker for connection ${connectionId} after a ` +
      `successful sync — it will clear on its own when the key expires: ` +
      `${err instanceof Error ? err.message : String(err)}`
    )
    reportError(err, {
      site:  'inngest.ownerrez-incremental-sync.circuit_breaker_reset',
      extra: { connection_id: connectionId },
    })
  }
}

// The cron tick (hourly, minute 0) whose fan-out requests the new-property
// diff — 10:00 UTC is early-morning US, away from the 13:00-14:00 UTC daily
// cron cluster and low booking-webhook traffic.
const NEW_PROPERTY_DIFF_UTC_HOUR = 10

export const ownerRezIncrementalSync = inngest.createFunction(
  {
    id:          'ownerrez-incremental-sync',
    name:        'OwnerRez Incremental Sync',
    retries:     2,
    concurrency: { limit: 1 },
  },
  [
    { cron: '0 * * * *' },
    { event: 'integration/ownerrez.sync.requested' as const },
    { event: 'ownerrez/sync.now.requested' as const },
  ],
  async ({ event, step, logger }) => {
    // Inngest's synthetic cron-tick event has no `data.user_id` — only the
    // two real event triggers carry one, and only when the webhook path
    // successfully resolved a connection (see ownerrez.ts's
    // handleWebhookEvent). Its absence means "do a full sweep", the same
    // behavior this function always had before scoping existed.
    const scopedUserId = event?.data && 'user_id' in event.data ? event.data.user_id : undefined
    logger.info('ownerrez-incremental-sync triggered', { scoped: Boolean(scopedUserId) })

    const connections = await step.run('fetch-connections', async () => {
      const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
      // PLATFORM-WIDE when unscoped — every org with a live OwnerRez
      // connection, not one tenant's. At max_rows = 1000 PostgREST returns the
      // first 1000 with a 200 and no truncation signal, so every connection
      // past that stops syncing while the cron still reports success. The
      // error was discarded outright too: a failed read became "no active
      // connections" and the whole tick was skipped silently.
      return await fetchAllRows<{ id: string; user_id: string; org_id: string | null; external_user_id: string | null }>(
        (from, to) => {
          let query = supabase
            .from('integration_connections')
            .select('id, user_id, org_id, external_user_id')
            .eq('provider_id', PROVIDER)
            .eq('status', 'active')

          if (scopedUserId) query = query.eq('user_id', scopedUserId)

          return query.order('id').range(from, to)
        },
        { label: 'ownerrez-incremental-sync.connections' },
      )
    })

    if (!connections.length) {
      logger.info('[OwnerRez] No active connections to sync')
      return { dispatched: 0 }
    }

    // The new-property diff costs one full getProperties() per connection —
    // budget-relevant at scale. Discovery is webhook-primary (see header):
    // the hourly backstop only requests it once a day, for webhooks that
    // never arrived. Scoped (webhook/manual) runs always get it.
    const checkNewProperties = scopedUserId
      ? true
      : new Date().getUTCHours() === NEW_PROPERTY_DIFF_UTC_HOUR

    // Circuit breaker, per connection. This replaces a single global check
    // that returned early for the WHOLE tick — one org's expired token used to
    // stop every other org from syncing. Each connection is now filtered on its
    // own breaker, so a failing tenant is skipped and healthy tenants proceed.
    // ownerRezConnectionSync re-checks its own breaker too (a run queued before
    // the breaker opened must not pile onto a degraded API), so this is an
    // optimisation to avoid dispatching no-op runs, not the enforcement point.
    const syncable = await step.run('filter-open-circuits', async () => {
      const open: string[] = []
      for (const conn of connections) {
        if (await isCircuitOpen(logger, conn.id)) open.push(conn.id)
      }
      return connections.filter((c) => !open.includes(c.id))
    })

    if (!syncable.length) {
      logger.warn('[OwnerRez] Every active connection has an open circuit breaker — skipping tick')
      return { dispatched: 0, circuit_open: true }
    }

    await step.sendEvent(
      'fan-out-connection-syncs',
      syncable.map((conn) => ({
        name: 'ownerrez/connection.sync.requested' as const,
        data: {
          connection_id:        conn.id,
          user_id:              conn.user_id,
          org_id:               conn.org_id ?? '',
          external_user_id:     conn.external_user_id ?? '',
          check_new_properties: checkNewProperties,
        },
      }))
    )

    return { dispatched: syncable.length }
  }
)


// ── sync-connection helpers ─────────────────────────────────────────────────
//
// The `sync-connection` step above used to inline all of this: property-id
// resolution, the booking upsert, owner-block notifications, cursor writes,
// and a three-branch error handler. Splitting them out keeps that step
// readable as the sequence it actually is (fetch → persist → notify →
// record) and lets each piece state its own failure contract.

type ActiveConnection = {
  id:               string
  user_id:          string
  org_id:           string
  external_user_id: string | null
  metadata:         unknown
}

type OwnerBlockRow   = MappedOwnerRezBookingRow
type SyncLogger      = { info: (msg: string, meta?: unknown) => void
                         warn: (msg: string) => void
                         error: (msg: string) => void }

type SyncSuccess = {
  affectedPropertyIds:   string[]
  bookingsToPostRevenue: { bookingId: string; propertyId: string; actualTotalAmount: number | null }[]
}

type SyncOutcome = SyncSuccess | { skipped: boolean; reason: string } | null | undefined

/**
 * External (OwnerRez) property ids for every property this org has synced.
 * Used only as the no-cursor fallback — OwnerRez requires either since_utc
 * or property_ids on getBookings().
 */
async function loadConnectedPropertyIds(
  supabase: ReturnType<typeof createServiceClient>,
  orgId:    string
): Promise<number[]> {
  const res = await supabase
    .from('properties')
    .select('external_id')
    .eq('org_id', orgId)
    .eq('external_source', PROVIDER)
    .limit(500)

  const data = unwrapList<{ external_id: string | null }>(res, {
    site: 'inngest.ownerrez-connection-sync.load-connected-properties',
    orgId,
  })

  return data
    .map((p) => Number(p.external_id))
    .filter((id) => !Number.isNaN(id))
}

/**
 * Upserts the fetched bookings and reports what changed.
 *
 * Returns null — never a partial success — when the OwnerRez→FieldStay
 * property-id lookup fails: CRITICAL-2 was exactly this, a booking upsert
 * running with an empty id map and writing property_id: null over every
 * value the initial sync had resolved. The caller must abort on null.
 */
async function persistBookings(
  supabase: ReturnType<typeof createServiceClient>,
  conn:     ActiveConnection,
  bookings: Awaited<ReturnType<OwnerRezApiClient['getBookings']>>,
  logger:   SyncLogger
): Promise<{ affectedPropertyIds: string[]
             bookingsToPostRevenue: SyncSuccess['bookingsToPostRevenue']
             ownerBlocks: OwnerBlockRow[] } | null> {
  if (!bookings.length) {
    return { affectedPropertyIds: [], bookingsToPostRevenue: [], ownerBlocks: [] }
  }

  const externalToFsId = await resolveExternalPropertyIdMap(supabase, conn.org_id, bookings)
  if (!externalToFsId) return null

  const builtRows = bookings.map((b) => buildOwnerRezBookingRow(conn.org_id, b, externalToFsId))
  const { mapped: bookingRows, unmappedCount } = partitionMappedBookingRows(builtRows)

  if (unmappedCount) {
    logger.warn(
      `[OwnerRez:${conn.user_id}] skipping ${unmappedCount} booking(s) whose OwnerRez property has no FieldStay property`
    )
  }
  if (!bookingRows.length) {
    return { affectedPropertyIds: [], bookingsToPostRevenue: [], ownerBlocks: [] }
  }

  // Chunked: an .upsert().select() returns at most max_rows = 1000 rows with
  // no truncation signal, and a short id map silently drops those bookings
  // from revenue posting. See upsert-bookings.ts.
  // No try/catch: the helper's message already carries the connection label,
  // and the enclosing step.run surfaces the throw. Catching only to re-log and
  // re-throw would add a log-only catch block for no added context.
  const idByExternalId = await upsertBookingsReturningIds(
    supabase, bookingRows, `OwnerRez:${conn.user_id}`)

  return {
    affectedPropertyIds: Array.from(new Set(bookingRows.map((b) => b.property_id))),
    bookingsToPostRevenue: selectOwnerRezBookingsToPostRevenue(bookingRows, idByExternalId),
    // Blocks never generate turnovers (filtered at the generator query level),
    // but a known vacancy window is the best signal for scheduling maintenance.
    ownerBlocks: bookingRows.filter((r) => Boolean(r.is_block)),
  }
}

/** OwnerRez external property id → FieldStay property id. null = lookup failed. */
async function resolveExternalPropertyIdMap(
  supabase: ReturnType<typeof createServiceClient>,
  orgId:    string,
  bookings: Awaited<ReturnType<OwnerRezApiClient['getBookings']>>
): Promise<Record<string, string> | null> {
  const externalPropertyIds = [...new Set(
    bookings
      .map((b) => b.property_id)
      .filter((id): id is number => id !== null)
      .map(String)
  )]

  if (!externalPropertyIds.length) return {}

  const { data: fsProps, error } = await supabase
    .from('properties')
    .select('id, external_id')
    .eq('org_id', orgId)
    .eq('external_source', PROVIDER)
    .in('external_id', externalPropertyIds)

  if (error || !fsProps) {
    console.error(
      `[OwnerRez sync] Property lookup failed for org ${orgId} — ` +
      `skipping booking upsert to prevent property_id null overwrite`,
      error?.message
    )
    reportError(
      new Error(error?.message ?? 'Property lookup returned no data'),
      { site: 'inngest.ownerrez-connection-sync.property_lookup', orgId },
    )
    return null
  }

  const map: Record<string, string> = {}
  for (const p of fsProps) {
    if (p.external_id) map[p.external_id] = p.id
  }
  return map
}

/** "Replace HVAC filter (~$120)" — cost suffix only when we have one. */
function describeMaintenanceCandidate(
  candidate: { name: string; estimated_cost?: number | null }
): string {
  const cost = candidate.estimated_cost ? ` (~$${candidate.estimated_cost})` : ''
  return `${candidate.name}${cost}`
}

/**
 * Notifies the PM about maintenance windows opened by owner blocks. Don't
 * wait for the next cron cycle — a known vacancy is actionable now. Sends
 * run in parallel and each failure is contained: one bad notification must
 * not abort the rest, and none of them can fail the sync.
 */
async function notifyOwnerBlockOpportunities(
  supabase:    ReturnType<typeof createServiceClient>,
  orgId:       string,
  ownerBlocks: OwnerBlockRow[],
  logger:      SyncLogger
): Promise<void> {
  if (!ownerBlocks.length) return

  // Batch-fetch property names for every owner-block property in one query
  // instead of a per-booking SELECT inside the loop.
  const blockProperties = await fetchAllRows<{ id: string; name: string | null }>(
    (from, to) => supabase
      .from('properties')
      .select('id, name')
      .in('id', [...new Set(ownerBlocks.map((b) => b.property_id))])
      .order('id')
      .range(from, to),
    { label: 'ownerrez-incremental.blockProperties' },
  )

  const propertyNameById = Object.fromEntries(
    blockProperties.map((p) => [p.id, p.name as string | null])
  ) as Record<string, string | null>

  // Bounded concurrency, then ONE insert.
  //
  // This was `Promise.all(ownerBlocks.map(...))` with no cap: every block
  // fired its own candidate query AND its own single-row notification insert,
  // all at once. For N blocks that is 2N simultaneous round trips from inside
  // a sync that is already holding connections — and N is driven by the
  // provider's calendar, not by anything here, so a backlog of owner blocks
  // decides how hard this hits the pool.
  //
  // Two separate fixes, because they are two separate problems:
  //   * the candidate LOOKUPS are genuinely per-block, so they are capped at
  //     CANDIDATE_CONCURRENCY rather than run all at once. Deliberately not
  //     p-limit — that is a new dependency for a bounded chunk loop this
  //     codebase already writes by hand in several places.
  //   * the notification WRITES are not per-block at all. They were only
  //     one-at-a-time because createPmNotification() takes one row.
  //     createPmNotifications() collapses them to a single statement.
  const CANDIDATE_CONCURRENCY = 5
  const pending: CreatePmNotificationInput[] = []

  for (let i = 0; i < ownerBlocks.length; i += CANDIDATE_CONCURRENCY) {
    const slice = ownerBlocks.slice(i, i + CANDIDATE_CONCURRENCY)

    const built = await Promise.all(
      slice.map(async (row): Promise<CreatePmNotificationInput | null> => {
        try {
          const candidates = await findMaintenanceCandidatesForWindow(
            supabase, orgId, row.property_id, row.checkin_date, row.checkout_date
          )
          if (!candidates.length) return null

          const items  = candidates.map(describeMaintenanceCandidate).join(', ')
          const window = `${new Date(row.checkin_date).toLocaleDateString()} – ${new Date(row.checkout_date).toLocaleDateString()}`

          return {
            orgId,
            type:      'maintenance_opportunity',
            title:     `Maintenance opportunity — ${propertyNameById[row.property_id] ?? 'Property'} blocked for owner use`,
            subtitle:  `Blocked ${window}. Candidates: ${items}`,
            href:      '/maintenance',
            severity:  'blue' as const,
            dedupeKey: `ownerrez-maint-opportunity-${row.external_id}`,
          }
        } catch (err) {
          // Per-block, as before: one property's candidate lookup failing must
          // not cost the other blocks their notification.
          logger.error(
            `[OwnerRez] Failed to build owner-block notification for booking ${row.external_id}: ${err instanceof Error ? err.message : String(err)}`
          )
          reportError(err, { site: 'inngest.ownerrez-incremental-sync.owner-block-notification', orgId })
          return null
        }
      })
    )

    pending.push(...built.filter((n) => n !== null))
  }

  if (!pending.length) return

  try {
    await createPmNotifications(supabase, pending)
  } catch (err) {
    // Non-fatal, matching the previous per-row behaviour: the bookings are
    // already persisted and the cursor still needs to advance. A failed
    // notification must not make the whole sync retry and re-upsert.
    logger.error(
      `[OwnerRez] Failed to persist ${pending.length} owner-block notification(s): ${err instanceof Error ? err.message : String(err)}`
    )
    reportError(err, { site: 'inngest.ownerrez-incremental-sync.owner-block-notification', orgId })
  }
}

/**
 * Advances the sync cursor. Non-fatal on failure: the bookings themselves
 * were already written correctly, and the next run simply re-reads a
 * slightly wider window (the cursor is deliberately the PRE-fetch timestamp
 * — see MEDIUM-3 — so re-reading is always safe).
 */
async function updateSyncCursor(
  conn:           ActiveConnection,
  fetchStartedAt: string,
  bookingCount:   number,
  logger:         SyncLogger
): Promise<void> {
  try {
    await mergeIntegrationConnectionMetadata({
      userId:     conn.user_id,
      providerId: PROVIDER,
      patch: {
        sync_cursor:      fetchStartedAt,
        last_synced_at:   new Date().toISOString(),
        last_sync_status: 'success',
        last_sync_error:  null,
        last_sync_count:  bookingCount,
      },
    })
  } catch (err) {
    logger.error(`[OwnerRez:${conn.user_id}] cursor update failed: ${err instanceof Error ? err.message : String(err)}`)
    reportError(err, { site: 'inngest.ownerrez-incremental-sync.update-sync-cursor' })
  }
}

/**
 * The three ways a connection sync fails, and what each one means for the
 * retry decision:
 *
 *   RateLimitError    → transient. Record it, RETHROW so Inngest retries with
 *                       backoff (the 5-minute budget window rolls well within
 *                       the retry schedule). Other connections are unaffected.
 *   TokenRevokedError → permanent until the PM reconnects. Mark the connection
 *                       revoked, notify, then throw NonRetriableError.
 *   anything else     → record status, count it against the circuit breaker,
 *                       notify, and RETURN (the step resolves without a sync
 *                       result, which the caller reads as "nothing synced").
 */
async function handleConnectionSyncFailure(
  err: unknown,
  ctx: { supabase: ReturnType<typeof createServiceClient>
         conn:     ActiveConnection
         userId:   string
         logger:   SyncLogger }
): Promise<void> {
  const { supabase, conn, userId, logger } = ctx
  const humanError = translateSyncError(err)

  if (err instanceof RateLimitError) {
    logger.warn(`[OwnerRez:${userId}] Rate limited (retry after ${err.retryAfter}s) — will retry with backoff`)
    reportError(err, { site: 'inngest.ownerrez-incremental-sync.sync-connection' })

    // Transient status only — don't flip the connection itself to 'error'.
    await mergeIntegrationConnectionMetadata({
      userId:     conn.user_id,
      providerId: PROVIDER,
      patch: { last_sync_status: 'rate_limited', last_sync_error: humanError },
    })

    throw err
  }

  if (err instanceof TokenRevokedError) {
    logger.error(`[OwnerRez:${userId}] Token revoked — marking connection as revoked`)

    await mergeIntegrationConnectionMetadata({
      userId:     conn.user_id,
      providerId: PROVIDER,
      patch: {
        last_sync_status: 'error',
        last_sync_error:  humanError,
        last_synced_at:   new Date().toISOString(),
      },
      status: 'revoked',
    })

    await logAuditEvent({
      orgId:      conn.org_id,
      action:     'integration.sync_failed',
      targetType: 'integration_connection',
      targetId:   conn.id,
      metadata:   { provider_id: PROVIDER, reason: 'token_revoked' },
    })

    await notifyConnectionErrorThrottled(supabase, conn.id, userId, conn.org_id, humanError)

    // MEDIUM-6: retrying only hits the same revoked token again. Raised after
    // the side effects above so this records as a distinct non-retriable
    // failure in Inngest's dashboard.
    throw new NonRetriableError(humanError)
  }

  logger.error(`[OwnerRez:${userId}] sync failed: ${err instanceof Error ? err.message : String(err)}`)

  await mergeIntegrationConnectionMetadata({
    userId:     conn.user_id,
    providerId: PROVIDER,
    patch: {
      last_sync_status: 'error',
      last_sync_error:  humanError,
      last_synced_at:   new Date().toISOString(),
    },
    status: 'error',
  })

  await logAuditEvent({
    orgId:      conn.org_id,
    action:     'integration.sync_failed',
    targetType: 'integration_connection',
    targetId:   conn.id,
    metadata:   { provider_id: PROVIDER, error: humanError },
  })

  await recordCircuitFailure(logger, conn.id)
  await notifyConnectionErrorThrottled(supabase, conn.id, userId, conn.org_id, humanError)
}


/**
 * Everything that has to happen after bookings land: turnover generation for
 * the touched properties, the turnover/created fan-out, and the guidebook /
 * asset-discovery seeding. Each is its own step so a failure in one retries
 * on its own without redoing the booking sync.
 *
 * Receives `step` rather than being inlined so the connection-sync handler
 * reads as its three phases (sync → post revenue → fan out). Only ever
 * called once per run, so the step ids inside stay unique.
 */
async function runPostSyncFanOut(
  step: GetStepTools<typeof inngest>,
  ctx:  { orgId: string | null; userId: string; affectedIds: string[]; logger: SyncLogger }
): Promise<void> {
  const { orgId, userId, affectedIds, logger } = ctx
  if (!affectedIds.length || !orgId) return

  // Called once per property (not per booking) so the generator sees the
  // full booking list and can apply its two-pass pairing logic correctly.
  const allNewTurnoverIds = await step.run('generate-turnovers', () =>
    generateTurnoversForProperties(orgId, affectedIds, userId, logger)
  )

  if (allNewTurnoverIds.length > 0) {
    const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
        const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
        return fetchTurnoverCreatedEvents(supabase, allNewTurnoverIds, orgId)
      })

    if (turnoverEvents.length > 0) {
      await step.sendEvent('fire-turnover-created-events', turnoverEvents)
    }
  }

  // Auto-create guidebook property configs for newly synced properties
  await step.run('create-guidebook-property-configs', () =>
    runNonFatal(
      () => createGuidebookPropertyConfigsForProperties(orgId, affectedIds),
      { label: `[OwnerRez:${userId}] guidebook config creation`, site: 'create-guidebook-property-configs', logger }
    )
  )

  // No-op until amenities data exists for these properties (this file
  // doesn't currently fetch property details — see the TODO at the top of
  // the file), but included for parity so it activates automatically once
  // it does.
  await step.run('seed-present-assets-from-amenities', () =>
    runNonFatal(
      () => seedPresentAssetsFromAmenities(orgId, affectedIds),
      { label: `[OwnerRez:${userId}] present-asset seeding`, site: 'seed-present-assets-from-amenities', logger }
    )
  )
}

/**
 * Generates turnovers for every touched property, returning the new turnover
 * ids. One property's failure is logged and reported but never blocks the
 * others — a single bad property must not cost the whole sync its turnovers.
 */
async function generateTurnoversForProperties(
  orgId:       string,
  propertyIds: string[],
  userId:      string,
  logger:      SyncLogger
): Promise<string[]> {
  const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
  const ids: string[] = []

  for (const propertyId of propertyIds) {
    try {
      ids.push(...await generateTurnoversForProperty(propertyId, orgId, supabase))
    } catch (err) {
      logger.error(
        `[OwnerRez:${userId}] Turnover generation failed for property ${propertyId}: ${err instanceof Error ? err.message : String(err)}`
      )
      reportError(err, { site: 'inngest.ownerrez-incremental-sync.generate-turnovers', orgId })
    }
  }

  return ids
}

/**
 * Runs a best-effort side effect: a failure is logged and reported, never
 * thrown. Used only where the booking data is already correctly written and
 * failing the step would just re-run work that succeeded.
 */
async function runNonFatal(
  fn:  () => Promise<unknown>,
  ctx: { label: string; site: string; logger: SyncLogger }
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    ctx.logger.error(`${ctx.label} failed: ${err instanceof Error ? err.message : String(err)}`)
    reportError(err, { site: `inngest.ownerrez-incremental-sync.${ctx.site}` })
  }
}


export const ownerRezConnectionSync = inngest.createFunction(
  {
    id:          'ownerrez-connection-sync',
    name:        'OwnerRez Connection Sync — per connection',
    retries:     3,
    // Global cap on concurrent OwnerRez API pressure. The shared-IP budget
    // in ownerrez-api.ts is the hard limit; this keeps burst shape sane.
    concurrency: { limit: 3 },
  },
  { event: 'ownerrez/connection.sync.requested' },
  async ({ event, step, logger }) => {
    const { connection_id: connectionId, user_id: userId, check_new_properties: checkNewProperties } = event.data
    const orgId = event.data.org_id || null

    // Queued runs dispatched before the breaker opened must not pile onto a
    // degraded API — re-check here, not just in the dispatcher.
    const circuitOpen = await step.run('check-circuit-breaker', () => isCircuitOpen(logger, connectionId))

    if (circuitOpen) {
      logger.warn(`[OwnerRez:${userId}] Circuit breaker open — skipping connection sync`)
      return { skipped: 'circuit_open' }
    }

    // ── Check for properties added in OwnerRez since the last sync ──────────
    // getBookings() below only ever asks about properties FieldStay already
    // knows — a property added in OwnerRez (or restored after a reconnect)
    // was otherwise invisible until the PM noticed and clicked "Resync" by
    // hand. Re-firing the initial-sync event is safe: its steps no-op for
    // properties that are fully set up.
    if (orgId && checkNewProperties) {
      const newPropertyIds = await step.run('check-new-properties', async () => {
        const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
        try {
          const orProperties = await new OwnerRezApiClient(userId).getProperties()
          if (!orProperties.length) return []

          // Unwrapped: this read decides which properties are NEW, so a
          // failure that returns null does not degrade — it amplifies.
          // `knownIds` becomes empty, EVERY OwnerRez property looks new, and
          // the block below re-fires integration/ownerrez.connected for the
          // whole org: a full initial sync per tick off one transient read.
          // (Its steps are idempotent, so this was wasted work rather than
          // corruption — but it is wasted work proportional to the org, on the
          // hour, until the read recovers.)
          const knownRes = await supabase
            .from('properties')
            .select('external_id')
            .eq('org_id', orgId)
            .eq('external_source', PROVIDER)
            .order('id')
            .limit(SUPABASE_MAX_ROWS)

          const known = unwrapList(knownRes, {
            site: 'inngest.ownerrez-connection-sync.known-properties', orgId,
          })
          const knownIds = new Set(known.map((p) => p.external_id))
          return orProperties
            .map((p) => String(p.id))
            .filter((id) => !knownIds.has(id))
        } catch (err) {
          logger.warn(`[OwnerRez:${userId}] new-property check failed: ${err instanceof Error ? err.message : String(err)}`)
          reportError(err, { site: 'inngest.ownerrez-incremental-sync.check-new-properties' })
          return []
        }
      })

      if (newPropertyIds.length) {
        logger.info(
          `[OwnerRez:${userId}] ${newPropertyIds.length} new propert` +
          `${newPropertyIds.length === 1 ? 'y' : 'ies'} found — re-running initial sync`
        )
        await step.sendEvent('fire-new-properties-sync', {
          name: 'integration/ownerrez.connected',
          data: {
            user_id:          userId,
            org_id:           orgId,
            external_user_id: event.data.external_user_id,
          },
        })
      }
    }

    const syncResult: SyncOutcome =
      await step.run('sync-connection', async () => {
        const supabase = createServiceClient({ system: 'inngest:incremental-sync' })

        // Re-fetch the connection: metadata (sync_cursor) and status may have
        // changed between dispatch and this run — a revoked/disconnected
        // connection must not be synced off a stale snapshot.
        // Unwrapped: a failed read returned null and was reported as
        // `connection_not_active`, which is both wrong and unactionable — the
        // run succeeded, Inngest did not retry, and the operator saw a healthy
        // connection labelled inactive. (No bookings were lost: the cursor
        // only advances on the success path, so the next tick refetches the
        // same window.)
        const connRes = await supabase
          .from('integration_connections')
          .select('id, user_id, org_id, external_user_id, metadata, status')
          .eq('id', connectionId)
          .maybeSingle()

        const conn = unwrap(connRes, {
          site: 'inngest.ownerrez-connection-sync.reload-connection',
          orgId: orgId ?? undefined,
        })

        if (!conn || conn.status !== 'active') {
          return { skipped: true, reason: 'connection_not_active' }
        }

        // org_id is nullable on integration_connections. A connection not
        // bound to an org cannot be tenant-scoped, so there is no org whose
        // properties or bookings this sync could safely write — skip rather
        // than carry a null org_id into the write path.
        if (!conn.org_id) {
          logger.warn(`[OwnerRez:${userId}] connection ${connectionId} has no org_id — skipping`)
          return { skipped: true, reason: 'connection_without_org' }
        }
        const activeConn: ActiveConnection = { ...conn, org_id: conn.org_id }

        const metadata = (conn.metadata ?? {}) as Record<string, unknown>
        const sinceUtc = (metadata['sync_cursor'] as string | undefined) ?? undefined

        // When no cursor exists yet (e.g. fresh reconnect before initial sync
        // sets one), fall back to property_ids so OwnerRez receives at least
        // one of its two required parameters.
        let propertyIds: number[] | undefined
        if (!sinceUtc) {
          propertyIds = await loadConnectedPropertyIds(supabase, activeConn.org_id)
          if (!propertyIds.length) {
            console.log(`[OwnerRez:${userId}] No connected properties and no sync cursor — skipping`)
            return { skipped: true, reason: 'no_cursor_no_properties' }
          }
        }

        // MEDIUM-3: capture timestamp BEFORE the fetch to close the race window.
        // Bookings modified during the fetch have a modified_at between fetchStartedAt
        // and the end of the fetch. Using fetchStartedAt as the new cursor ensures
        // they are re-fetched on the next incremental run.
        const fetchStartedAt = new Date().toISOString()

        try {
          const bookings = await new OwnerRezApiClient(userId)
            .getBookings({ sinceUtc, propertyIds, includeGuest: true })

          const persisted = await persistBookings(supabase, activeConn, bookings, logger)
          if (!persisted) {
            // Property lookup failed — already logged and reported. Bailing
            // out here is what prevents a booking upsert from overwriting
            // every resolved property_id with null.
            return
          }

          await notifyOwnerBlockOpportunities(supabase, activeConn.org_id, persisted.ownerBlocks, logger)
          await updateSyncCursor(activeConn, fetchStartedAt, bookings.length, logger)

          logger.info(`[OwnerRez:${userId}] sync complete — ${bookings.length} bookings`, {
            bookingCount: bookings.length,
          })

          await resetCircuitBreaker(logger, activeConn.id)

          return {
            affectedPropertyIds:   persisted.affectedPropertyIds,
            bookingsToPostRevenue: persisted.bookingsToPostRevenue,
          }
        } catch (err) {
          // Rethrows for the retriable/permanent cases; returns for the
          // generic one, which has already recorded status + notified the PM.
          await handleConnectionSyncFailure(err, { supabase, conn: activeConn, userId, logger })
        }
      })

    const affectedIds = syncResult && 'affectedPropertyIds' in syncResult
      ? syncResult.affectedPropertyIds
      : []

    // Post booking revenue for newly-confirmed guest-stay bookings. Mirrors
    // Hospitable's incremental-sync pattern: sendEvent happens at the top
    // level of the function body, never nested inside step.run.
    // actual_total_amount now comes from extractOwnerRezActualTotal
    // (charges[].owner_amount / total_amount, confirmed live 2026-07-15);
    // booking-events.ts's handleBookingConfirmed still falls back to the
    // avg_nightly_rate estimate whenever it's null.
    const bookingsToPostRevenue = syncResult && 'bookingsToPostRevenue' in syncResult
      ? syncResult.bookingsToPostRevenue
      : []
    if (bookingsToPostRevenue.length > 0 && orgId) {
      await step.sendEvent(
        'post-booking-revenue',
        bookingsToPostRevenue.map((b) => ({
          name: 'booking/confirmed' as const,
          data: {
            booking_id:          b.bookingId,
            property_id:         b.propertyId,
            org_id:              orgId,
            source:              'ownerrez' as const,
            actual_total_amount: b.actualTotalAmount,
          },
        }))
      )
    }

    await runPostSyncFanOut(step, { orgId, userId, affectedIds, logger })

    const synced = Boolean(syncResult && 'affectedPropertyIds' in syncResult)
    return { connectionId, synced }
  }
)

/**
 * Fire a PM notification about a broken connection — throttled to once per
 * 4 hours per connection via an org_milestones timestamp. Shared by the
 * token-revoked and generic-error paths (previously duplicated inline).
 * Runs inside the sync step, so failures here are deliberately swallowed:
 * connection status/metadata were already written.
 */
async function notifyConnectionErrorThrottled(
  supabase: ReturnType<typeof createServiceClient>,
  connectionId: string,
  userId: string,
  orgId: string,
  humanError: string
): Promise<void> {
  try {
    const milestoneKey = `integration_error_notified:${connectionId}`
    const { data: recentNotification, error: recentNotificationError } = await supabase
      .from('org_milestones')
      .select('value, achieved_at')
      .eq('org_id', orgId)
      .eq('milestone', milestoneKey)
      .order('achieved_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (isRealQueryError(recentNotificationError)) {
      console.error('[notifyConnectionErrorThrottled] recent-notification lookup failed:', recentNotificationError)
      reportError(recentNotificationError, {
        site: 'inngest.ownerrez-connection-sync.notify-error-throttle',
        orgId,
      })
    }

    const lastNotifiedAt = (recentNotification?.value as Record<string, unknown> | null)
      ?.notified_at
    const tooSoon = lastNotifiedAt &&
      Date.now() - new Date(lastNotifiedAt as string).getTime() < 4 * 60 * 60 * 1000

    if (!tooSoon) {
      // Revoked tokens are the most important case to notify on: only the PM
      // can fix them by reconnecting, and they never self-resolve on retry.
      await inngest.send({
        name: 'integration/connection.error',
        data: {
          user_id:     userId,
          org_id:      orgId,
          provider_id: PROVIDER,
          reason:      humanError,
        },
      })
      const { error: milestoneError } = await supabase.from('org_milestones').upsert({
        org_id:    orgId,
        milestone: milestoneKey,
        value:     { notified_at: new Date().toISOString() },
      }, { onConflict: 'org_id,milestone' })
      if (milestoneError) {
        console.error('[notifyConnectionErrorThrottled] milestone upsert failed:', milestoneError)
        reportError(milestoneError, {
          site: 'inngest.ownerrez-connection-sync.notify-error-throttle-milestone',
          orgId,
        })
      }
    }
  } catch { /* non-fatal — connection status was already written */ }
}
