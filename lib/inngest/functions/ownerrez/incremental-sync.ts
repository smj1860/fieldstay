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
import { fetchAllRows } from '@/lib/inngest/paginate'
import { NonRetriableError }            from 'inngest'
import type { GetStepTools }            from 'inngest'
import { createServiceClient }          from '@/lib/supabase/server'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { OwnerRezApiClient, getRedis }  from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import { logAuditEvent }                from '@/lib/audit'
import { reportError }                  from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { createPmNotification }         from '@/lib/inngest/helpers'
import { findMaintenanceCandidatesForWindow } from '@/lib/maintenance/vacancy-suggestions'
import { createGuidebookPropertyConfigsForProperties } from '@/lib/guidebook/sync'
import { seedPresentAssetsFromAmenities } from '@/lib/asset-discovery/seed-from-amenities'
import {
  buildOwnerRezBookingRow,
  selectOwnerRezBookingsToPostRevenue,
} from '@/lib/integrations/providers/ownerrez'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'

const PROVIDER = 'ownerrez'

const CIRCUIT_KEY       = 'ownerrez:circuit:consecutive_failures'
const CIRCUIT_THRESHOLD = 10

// ── Circuit breaker ─────────────────────────────────────────────────────────
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
let localCircuitFailures = 0

async function isCircuitOpen(logger: { warn: (msg: string) => void }): Promise<boolean> {
  try {
    const failCount = await getRedis().get<number>(CIRCUIT_KEY) ?? 0
    return failCount >= CIRCUIT_THRESHOLD
  } catch (err) {
    logger.warn(
      `[OwnerRez] Circuit-breaker state unreadable (Redis error) — falling back to the ` +
      `in-memory failure count (${localCircuitFailures}/${CIRCUIT_THRESHOLD}): ` +
      `${err instanceof Error ? err.message : String(err)}`
    )
    reportError(err, {
      site:  'inngest.ownerrez-incremental-sync.circuit_breaker_read',
      extra: { localCircuitFailures },
    })
    return localCircuitFailures >= CIRCUIT_THRESHOLD
  }
}

async function recordCircuitFailure(logger: { warn: (msg: string) => void }): Promise<void> {
  localCircuitFailures++
  try {
    const redis    = getRedis()
    const newCount = await redis.incr(CIRCUIT_KEY)
    if (newCount === 1) await redis.expire(CIRCUIT_KEY, 30 * 60)
  } catch (err) {
    logger.warn(
      `[OwnerRez] Could not record circuit-breaker failure in Redis — the shared counter ` +
      `is not advancing; only the in-memory fallback (${localCircuitFailures}/` +
      `${CIRCUIT_THRESHOLD}) is protecting the API: ${err instanceof Error ? err.message : String(err)}`
    )
    reportError(err, {
      site:  'inngest.ownerrez-incremental-sync.circuit_breaker_increment',
      extra: { localCircuitFailures },
    })
  }
}

async function resetCircuitBreaker(logger: { warn: (msg: string) => void }): Promise<void> {
  localCircuitFailures = 0
  try {
    await getRedis().del(CIRCUIT_KEY)
  } catch (err) {
    // Failing to CLEAR the breaker errs toward staying closed — safe, but
    // it can keep syncs paused for up to the key's 30-minute TTL, so say so.
    logger.warn(
      `[OwnerRez] Could not reset the circuit breaker after a successful sync — it will ` +
      `clear on its own when the key expires: ${err instanceof Error ? err.message : String(err)}`
    )
    reportError(err, { site: 'inngest.ownerrez-incremental-sync.circuit_breaker_reset' })
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

    // Circuit breaker: if the OwnerRez API is degraded, skip this tick
    // entirely rather than queueing per-connection runs that will all fail.
    const circuitOpen = await step.run('check-circuit-breaker', () => isCircuitOpen(logger))

    if (circuitOpen) {
      logger.warn('[OwnerRez] Circuit breaker open — skipping tick, waiting for recovery')
      return { dispatched: 0, circuit_open: true }
    }

    const connections = await step.run('fetch-connections', async () => {
      const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
      let query = supabase
        .from('integration_connections')
        .select('id, user_id, org_id, external_user_id')
        .eq('provider_id', PROVIDER)
        .eq('status', 'active')

      if (scopedUserId) query = query.eq('user_id', scopedUserId)

      const { data } = await query
      return data ?? []
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

    await step.sendEvent(
      'fan-out-connection-syncs',
      connections.map((conn) => ({
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

    return { dispatched: connections.length }
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

type BookingRow      = ReturnType<typeof buildOwnerRezBookingRow>
type OwnerBlockRow   = BookingRow & { property_id: string }
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
  const { data } = await supabase
    .from('properties')
    .select('external_id')
    .eq('org_id', orgId)
    .eq('external_source', PROVIDER)

  return ((data ?? []) as Array<{ external_id: string | null }>)
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

  const bookingRows = bookings.map((b) => buildOwnerRezBookingRow(conn.org_id, b, externalToFsId))

  const { data: upserted, error } = await supabase
    .from('bookings')
    .upsert(bookingRows, { onConflict: 'org_id,external_id,external_source' })
    .select('id, external_id')

  if (error) {
    logger.error(`[OwnerRez:${conn.user_id}] bookings upsert: ${error.message}`)
    throw new Error(error.message)
  }

  const idByExternalId = Object.fromEntries(
    (upserted ?? []).map((row) => [row.external_id, row.id as string])
  )

  return {
    affectedPropertyIds: Array.from(new Set(
      bookingRows.map((b) => b.property_id).filter((id): id is string => id !== null)
    )),
    bookingsToPostRevenue: selectOwnerRezBookingsToPostRevenue(bookingRows, idByExternalId),
    // Blocks never generate turnovers (filtered at the generator query level),
    // but a known vacancy window is the best signal for scheduling maintenance.
    ownerBlocks: bookingRows.filter(
      (r): r is OwnerBlockRow => Boolean(r.is_block) && r.property_id !== null
    ),
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

  await Promise.all(
    ownerBlocks.map(async (row) => {
      try {
        const candidates = await findMaintenanceCandidatesForWindow(
          supabase, row.property_id, row.checkin_date, row.checkout_date
        )
        if (!candidates.length) return

        const items = candidates.map(describeMaintenanceCandidate).join(', ')
        const window = `${new Date(row.checkin_date).toLocaleDateString()} – ${new Date(row.checkout_date).toLocaleDateString()}`

        await createPmNotification(supabase, {
          orgId,
          type:      'maintenance_opportunity',
          title:     `Maintenance opportunity — ${propertyNameById[row.property_id] ?? 'Property'} blocked for owner use`,
          subtitle:  `Blocked ${window}. Candidates: ${items}`,
          href:      '/maintenance',
          severity:  'blue',
          dedupeKey: `ownerrez-maint-opportunity-${row.external_id}`,
        })
      } catch (err) {
        logger.error(
          `[OwnerRez] Failed to send owner-block notification for booking ${row.external_id}: ${err instanceof Error ? err.message : String(err)}`
        )
        reportError(err, { site: 'inngest.ownerrez-incremental-sync.owner-block-notification', orgId })
      }
    })
  )
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

  await recordCircuitFailure(logger)
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
    const circuitOpen = await step.run('check-circuit-breaker', () => isCircuitOpen(logger))

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

          const { data: known } = await supabase
            .from('properties')
            .select('external_id')
            .eq('org_id', orgId)
            .eq('external_source', PROVIDER)

          const knownIds = new Set((known ?? []).map((p) => p.external_id))
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
        const { data: conn } = await supabase
          .from('integration_connections')
          .select('id, user_id, org_id, external_user_id, metadata, status')
          .eq('id', connectionId)
          .maybeSingle()

        if (!conn || conn.status !== 'active') {
          return { skipped: true, reason: 'connection_not_active' }
        }

        const metadata = (conn.metadata ?? {}) as Record<string, unknown>
        const sinceUtc = (metadata['sync_cursor'] as string | undefined) ?? undefined

        // When no cursor exists yet (e.g. fresh reconnect before initial sync
        // sets one), fall back to property_ids so OwnerRez receives at least
        // one of its two required parameters.
        let propertyIds: number[] | undefined
        if (!sinceUtc) {
          propertyIds = await loadConnectedPropertyIds(supabase, conn.org_id)
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

          const persisted = await persistBookings(supabase, conn, bookings, logger)
          if (!persisted) {
            // Property lookup failed — already logged and reported. Bailing
            // out here is what prevents a booking upsert from overwriting
            // every resolved property_id with null.
            return
          }

          await notifyOwnerBlockOpportunities(supabase, conn.org_id, persisted.ownerBlocks, logger)
          await updateSyncCursor(conn, fetchStartedAt, bookings.length, logger)

          logger.info(`[OwnerRez:${userId}] sync complete — ${bookings.length} bookings`, {
            bookingCount: bookings.length,
          })

          await resetCircuitBreaker(logger)

          return {
            affectedPropertyIds:   persisted.affectedPropertyIds,
            bookingsToPostRevenue: persisted.bookingsToPostRevenue,
          }
        } catch (err) {
          // Rethrows for the retriable/permanent cases; returns for the
          // generic one, which has already recorded status + notified the PM.
          await handleConnectionSyncFailure(err, { supabase, conn, userId, logger })
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
  orgId: string | null,
  humanError: string
): Promise<void> {
  try {
    const milestoneKey = `integration_error_notified:${connectionId}`
    const { data: recentNotification } = await supabase
      .from('org_milestones')
      .select('value, achieved_at')
      .eq('org_id', orgId)
      .eq('milestone', milestoneKey)
      .order('achieved_at', { ascending: false })
      .limit(1)
      .maybeSingle()

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
          org_id:      orgId ?? '',
          provider_id: PROVIDER,
          reason:      humanError,
        },
      })
      await supabase.from('org_milestones').upsert({
        org_id:    orgId,
        milestone: milestoneKey,
        value:     { notified_at: new Date().toISOString() },
      }, { onConflict: 'org_id,milestone' })
    }
  } catch { /* non-fatal — connection status was already written */ }
}
