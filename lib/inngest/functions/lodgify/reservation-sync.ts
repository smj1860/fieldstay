// lib/inngest/functions/lodgify/reservation-sync.ts
// ============================================================================
// The Lodgify-specific half of the reservation sync: decide what to fetch,
// fetch it, map it. Everything after that — the upsert, the two silent-drop
// guards, revenue posting and turnover regeneration — is provider-agnostic and
// lives in ../shared/reservation-pipeline.ts, shared with Hospitable, Hostex
// and Hostaway.
//
// Three callers need this: lodgifyInitialSync (window, 12 months back),
// lodgifyReservationReconcileHandler (window, 1 month back) and
// lodgifyWebhookHandler (one booking named by a delivery, or — when the
// delivery named none it could recognise — a short recent window).
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest } from '@/lib/inngest/client'
import {
  lodgifyBookingWindow,
  lodgifyFetchBookingById,
  lodgifyFetchBookings,
} from '@/lib/integrations/providers/lodgify-api'
import { lodgifyBookingToNormalized } from '@/lib/integrations/providers/lodgify.mappers'
import {
  runReservationPipeline,
  type RevenueMode,
  type SyncLogger,
  type ReservationPipelineResult,
} from '../shared/reservation-pipeline'

export type { RevenueMode }

const PROVIDER = 'lodgify' as const

type SyncStep = GetStepTools<typeof inngest>

/**
 * What this run should fetch.
 *
 * A discriminated union rather than optional fields so the modes cannot be
 * half-specified: a webhook run that also carried a window, or a cron run with
 * neither, would both typecheck under optional params and then quietly fetch
 * the wrong thing.
 */
export type LodgifyFetchMode =
  /** A date range — initial sync, the daily reconcile, and the webhook fallback. */
  | { kind: 'window'; historyMonths: number; lookaheadMonths: number }
  /** Specific bookings by id — a webhook delivery naming one. */
  | { kind: 'ids'; bookingIds: string[] }

export interface LodgifyReservationSyncParams {
  step:   SyncStep
  logger: SyncLogger
  /**
   * Acquires a CURRENT credential. A getter, not a value — see the
   * "credentials are not step state" note in
   * lib/integrations/providers/hospitable-token.ts. Resolving it once would
   * let Inngest memoize it into step state and replay it on every retry, so a
   * key rotated mid-run could never be recovered from.
   *
   * Lodgify keys do not expire, but a PM who rotates one in Lodgify and
   * reconnects is exactly the case this shape survives.
   */
  getToken: () => Promise<string>
  orgId:  string
  userId: string
  /** Lodgify property id (as a string) → FieldStay properties.id. */
  propertyIdMap: Record<string, string>
  fetchMode:     LodgifyFetchMode
  system:        string
  revenueMode:   RevenueMode
}

export async function syncLodgifyReservations(
  params: LodgifyReservationSyncParams,
): Promise<ReservationPipelineResult> {
  const { step, logger, getToken, orgId, userId, propertyIdMap, fetchMode, system, revenueMode } = params

  // ── Fetch — the only genuinely Lodgify-specific part ─────────────────────
  // One step, one request range. Lodgify's quota is per-account-key, so one
  // org's backfill cannot starve another's and there is no reason for the
  // per-window fan-out Hospitable needs against its shared platform budget.
  const bookings = await step.run('fetch-reservations', async () => {
    if (!Object.keys(propertyIdMap).length) return []

    if (fetchMode.kind === 'ids') {
      // Webhook path. The delivery is treated as a ping: we re-read current
      // state with our own credential rather than believing anything in the
      // body. An id resolving to nothing (hard-deleted between delivery and
      // read) drops out rather than failing the run.
      //
      // One credential acquisition for the whole fan-out rather than one per
      // id: this is inside the step, so a retry re-reads it, and re-resolving
      // per id would issue N connection+Vault reads for a single logical fetch.
      const token   = await getToken()
      const fetched = await Promise.all(
        fetchMode.bookingIds.map((id) => lodgifyFetchBookingById(token, userId, id)),
      )
      return fetched.filter((b): b is NonNullable<typeof b> => b !== null)
    }

    const window = lodgifyBookingWindow(fetchMode.historyMonths, fetchMode.lookaheadMonths)
    return lodgifyFetchBookings(await getToken(), userId, window)
  })

  logger.info(`[Lodgify:${userId}] Fetched ${bookings.length} bookings`)

  return runReservationPipeline({
    step,
    logger,
    provider:     PROVIDER,
    orgId,
    userId,
    propertyIdMap,
    reservations: bookings.map(lodgifyBookingToNormalized),
    system,
    revenueMode,
  })
}
