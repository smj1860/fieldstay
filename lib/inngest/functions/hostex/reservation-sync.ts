// lib/inngest/functions/hostex/reservation-sync.ts
// ============================================================================
// The Hostex-specific half of the reservation sync: decide what to fetch,
// fetch it, map it. Everything after that — the upsert, the two silent-drop
// guards, revenue posting and turnover regeneration — is provider-agnostic and
// lives in ../shared/reservation-pipeline.ts, shared with Hospitable.
//
// Three callers need this: hostexInitialSync (window, 12 months back),
// hostexReservationReconcileHandler (window, 1 month back) and
// hostexWebhookHandler (a single reservation named by a delivery).
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest } from '@/lib/inngest/client'
import {
  hostexFetchReservations,
  hostexFetchReservationByCode,
  hostexReservationWindow,
} from '@/lib/integrations/providers/hostex-api'
import { hostexReservationToNormalized } from '@/lib/integrations/providers/hostex.mappers'
import {
  runReservationPipeline,
  type RevenueMode,
  type SyncLogger,
  type ReservationPipelineResult,
} from '../shared/reservation-pipeline'

export type { RevenueMode }

const PROVIDER = 'hostex' as const

type SyncStep = GetStepTools<typeof inngest>

/**
 * What this run should fetch.
 *
 * A discriminated union rather than optional fields so the two modes cannot be
 * half-specified: a webhook run that also carried a window, or a cron run with
 * neither, would both typecheck under optional params and then quietly fetch
 * the wrong thing.
 */
export type HostexFetchMode =
  /** A date range of check-outs — initial sync and the daily reconcile. */
  | { kind: 'window'; historyMonths: number; lookaheadMonths: number }
  /** Specific reservations by code — a webhook delivery naming one. */
  | { kind: 'codes'; reservationCodes: string[] }

export interface HostexReservationSyncParams {
  step:   SyncStep
  logger: SyncLogger
  /**
   * Acquires a CURRENT token. A getter, not a token — see the "credentials are
   * not step state" note in lib/integrations/providers/hospitable-token.ts.
   * Resolving it once would let Inngest memoize it into step state and replay
   * it on every retry, so a token invalidated mid-run could never be recovered.
   */
  getToken: () => Promise<string>
  orgId:  string
  userId: string
  /** Hostex property id (as a string) → FieldStay properties.id. */
  propertyIdMap: Record<string, string>
  fetchMode:     HostexFetchMode
  system:        string
  revenueMode:   RevenueMode
}

export async function syncHostexReservations(
  params: HostexReservationSyncParams,
): Promise<ReservationPipelineResult> {
  const { step, logger, getToken, orgId, userId, propertyIdMap, fetchMode, system, revenueMode } = params

  // ── Fetch — the only genuinely Hostex-specific part ──────────────────────
  // One step, one request range. Hospitable fans out per-window because its 54
  // req/min budget is shared platform-wide and a late failure would re-fetch
  // everything; Hostex's budget is per-token at 600 req/min, so the pressure
  // that justified that complexity does not exist here.
  const reservations = await step.run('fetch-reservations', async () => {
    if (!Object.keys(propertyIdMap).length) return []

    if (fetchMode.kind === 'codes') {
      // Webhook path: Hostex's delivery is a ping carrying identifiers only —
      // its own guidance is that the payload "only confirms THAT the
      // reservation changed" — so current state is read back by code. A code
      // resolving to nothing (hard-deleted between delivery and read) drops
      // out rather than failing the run.
      // One acquisition for the whole fan-out rather than one per code: this
      // is inside the step, so a retry re-reads it, and re-resolving per code
      // would issue N connection+Vault reads for a single logical fetch.
      const token   = await getToken()
      const fetched = await Promise.all(
        fetchMode.reservationCodes.map((code) => hostexFetchReservationByCode(token, userId, code)),
      )
      return fetched.filter((r): r is NonNullable<typeof r> => r !== null)
    }

    const window = hostexReservationWindow(fetchMode.historyMonths, fetchMode.lookaheadMonths)
    return hostexFetchReservations(await getToken(), userId, window)
  })

  logger.info(`[Hostex:${userId}] Fetched ${reservations.length} reservations`)

  return runReservationPipeline({
    step,
    logger,
    provider:     PROVIDER,
    orgId,
    userId,
    propertyIdMap,
    reservations: reservations.map(hostexReservationToNormalized),
    system,
    revenueMode,
  })
}
