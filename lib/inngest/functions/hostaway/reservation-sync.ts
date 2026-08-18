// lib/inngest/functions/hostaway/reservation-sync.ts
// ============================================================================
// The Hostaway-specific half of the reservation sync: decide what to fetch,
// fetch it, map it. Everything after that — the upsert, the two silent-drop
// guards, revenue posting and turnover regeneration — is provider-agnostic and
// lives in ../shared/reservation-pipeline.ts, shared with Hospitable and
// Hostex.
//
// Three callers will need this, matching Hostex's shape: hostawayInitialSync
// (window, 12 months back), the reconcile handler (window, 1 month back) and
// the webhook handler (specific reservations named by a delivery).
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest } from '@/lib/inngest/client'
import { hostawayFetchReservations } from '@/lib/integrations/providers/hostaway'
import { hostawayReservationToNormalized } from '@/lib/integrations/providers/hostaway.mappers'
import {
  runReservationPipeline,
  type RevenueMode,
  type SyncLogger,
  type ReservationPipelineResult,
} from '../shared/reservation-pipeline'

export type { RevenueMode }

const PROVIDER = 'hostaway' as const

type SyncStep = GetStepTools<typeof inngest>

/**
 * What this run should fetch.
 *
 * A discriminated union rather than optional fields so the two modes cannot be
 * half-specified — the same reasoning as HostexFetchMode: a webhook run that
 * also carried a window, or a cron run with neither, would both typecheck under
 * optional params and then quietly fetch the wrong thing.
 */
export type HostawayFetchMode =
  /** History depth in months — initial sync and the daily reconcile. */
  | { kind: 'window'; historyMonths: number }
  /**
   * Everything CHANGED since an ISO date — the hourly incremental sweep.
   *
   * A different question from `window`, not a narrower one. An arrival-date
   * filter anchored near today cannot see a cancellation of a stay six months
   * out; `latestActivityStart` can, and that is the change most worth hearing
   * about inside the hour rather than at tomorrow's reconcile.
   */
  | { kind: 'activitySince'; since: string }
  /** Specific reservation ids — a webhook delivery naming one. */
  | { kind: 'ids'; reservationIds: string[] }

export interface HostawayReservationSyncParams {
  step:   SyncStep
  logger: SyncLogger
  /** Hostaway Bearer token for this connection. */
  token:  string
  orgId:  string
  /** Only labels log lines, matching the existing `[Hostaway:<id>]` prefix. */
  userId: string
  /** Hostaway listing id (as a string) → FieldStay properties.id. */
  propertyIdMap: Record<string, string>
  fetchMode:     HostawayFetchMode
  /** Names the RLS bypass for createServiceClient — see ServiceRoleContext. */
  system:        string
  revenueMode:   RevenueMode
}

/**
 * `arrivalStartDate` for GET /reservations, N months back from today.
 *
 * Hostaway's endpoint takes a date, not a month count. 12 months on first sync
 * is what makes an owner's first-year P&L meaningful, which is the whole
 * reason for importing past stays.
 *
 * The claim that used to sit here — that the endpoint "defaults to 90 days of
 * history when none is sent" — was unverifiable and is removed: the parameter
 * this function fed was `dateFrom`, which Hostaway does not accept, so no
 * window was ever actually requested and the 90-day figure described nothing
 * that happened.
 *
 * Deliberately no lookahead bound: unlike Hostex's window, Hostaway's
 * pagination is driven by `dateFrom` alone and future reservations are what a
 * turnover schedule is built from — capping the far end would silently drop
 * next season's bookings.
 */
export function hostawayHistoryCutoff(historyMonths: number): string {
  const from = new Date()
  from.setMonth(from.getMonth() - historyMonths)
  // YYYY-MM-DD — what the API expects.
  return from.toISOString().slice(0, 10)
}

export async function syncHostawayReservations(
  params: HostawayReservationSyncParams,
): Promise<ReservationPipelineResult> {
  const { step, logger, token, orgId, userId, propertyIdMap, fetchMode, system, revenueMode } = params

  // ── Fetch — the only genuinely Hostaway-specific part ────────────────────
  // One step, one paginated range. hostawayFetchReservations THROWS rather
  // than truncating when it exceeds its page cap, which is what lets the
  // reconcile pass registered in absence-reconciliation.test.ts qualify as
  // `fetch-fails-loud`: a partial result returned as complete is
  // indistinguishable from a shrunken portfolio to everything downstream.
  const reservations = await step.run('fetch-reservations', async () => {
    if (!Object.keys(propertyIdMap).length) return []

    if (fetchMode.kind === 'ids') {
      // Webhook path. Hostaway's unified webhook carries the reservation body,
      // but re-reading current state is what makes a delivery that arrives out
      // of order (modified before created) still converge — the same reason
      // Hostex reads back by code. Filtered client-side because /reservations
      // has no id-list parameter; the window is already bounded to recent
      // history, which is where a webhook's subject always lives.
      const wanted = new Set(fetchMode.reservationIds)
      const recent = await hostawayFetchReservations(token, {
        kind: 'arrivalFrom', date: hostawayHistoryCutoff(1),
      })
      return recent.filter((r) => wanted.has(String(r.id)))
    }

    if (fetchMode.kind === 'activitySince') {
      return hostawayFetchReservations(token, {
        kind: 'activitySince', date: fetchMode.since,
      })
    }

    return hostawayFetchReservations(token, {
      kind: 'arrivalFrom', date: hostawayHistoryCutoff(fetchMode.historyMonths),
    })
  })

  logger.info(`[Hostaway:${userId}] Fetched ${reservations.length} reservations`)

  return runReservationPipeline({
    step,
    logger,
    provider:     PROVIDER,
    orgId,
    userId,
    propertyIdMap,
    reservations: reservations.map(hostawayReservationToNormalized),
    system,
    revenueMode,
  })
}
