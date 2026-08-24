// lib/inngest/functions/hospitable/reservation-sync.ts
// ============================================================
// The Hospitable-specific half of the reservation sync: fetch the windows,
// map them. Everything after that — the upsert, the two silent-drop guards,
// the revenue-eligibility predicate and the turnover regeneration — is
// provider-agnostic and lives in ../shared/reservation-pipeline.ts, shared
// with Hostex.
//
// It moved there when the Hostex sync landed as a near-copy of this file
// (SonarCloud: 45.8% duplicated on the introducing PR). The duplicated part
// was not boilerplate — it was exactly the guards and the max_rows-safe
// revenue read that this repo has been bitten by before, and a second copy is
// a second place for each to be fixed in isolation.
//
// WHAT STAYED HERE is the fetch, because it is irreducibly provider-specific:
// one Inngest step per date window, so a rate-limit throw on window 20 does
// not discard windows 1-19 and restart. Hostex needs none of that — its
// budget is per-token rather than a shared 54 req/min.
//
// Two callers need this sequence:
//   - hospInitialSync                 — once, when a PM connects
//   - hospReservationReconcileHandler — daily, as the missed-webhook backstop
//
// Step ids are unchanged from when the whole pipeline was inline here, so an
// in-flight run mid-deploy resumes on the same ids rather than replaying.
//
// STEP TOOLING: this module lives under lib/inngest/, which is where
// unit/guardrails/inngest-nested-steps.test.ts permits a helper to receive
// `step`. Every step.run/sendEvent below is at this function's top level —
// none is nested inside another step's callback.
// ============================================================

import type { GetStepTools }  from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import {
  hospReservationWindows,
  fetchReservationsWindow,
  hospitableReservationToNormalized,
  type HospitableReservation,
} from '@/lib/integrations/providers/hospitable'
import {
  runReservationPipeline,
  type RevenueMode,
  type SyncLogger,
  type ReservationPipelineResult,
} from '../shared/reservation-pipeline'

// Re-exported so existing importers of these names from this module are
// unaffected by the extraction.
export type { RevenueMode }

const PROVIDER = 'hospitable' as const

type SyncStep = GetStepTools<typeof inngest>

export interface ReservationSyncParams {
  step:   SyncStep
  logger: SyncLogger
  /**
   * Acquires a CURRENT Hospitable token. A getter, not a token — see the
   * "credentials are not step state" note in hospitable-token.ts. This
   * pipeline fetches one Inngest step per date window, so a single token
   * value would be memoized across the whole sweep and every retry of a late
   * window would replay a credential minted before the sweep began.
   */
  getToken: () => Promise<string>
  orgId:  string
  /** Only used to label log lines, matching the existing `[Hospitable:<id>]` prefix. */
  userId: string
  /** Hospitable property external_id → FieldStay properties.id. */
  propertyIdMap:   Record<string, string>
  /** How far forward to sweep. */
  lookaheadMonths: number
  /** Names the RLS bypass for createServiceClient — see ServiceRoleContext. */
  system:      string
  revenueMode: RevenueMode
}

export type ReservationSyncResult = ReservationPipelineResult

/**
 * Fetches every reservation in the window, then hands them to the shared
 * pipeline to upsert, post revenue for, and regenerate turnovers from.
 *
 * Call at most ONCE per Inngest run — the step ids are fixed, so a second call
 * in the same run would collide.
 */
export async function syncHospitableReservations(
  params: ReservationSyncParams,
): Promise<ReservationSyncResult> {
  const {
    step, logger, getToken, orgId, userId,
    propertyIdMap, lookaheadMonths, system, revenueMode,
  } = params

  // ── Fetch reservations, one Inngest step per start_date window ───────────
  //     Each window retries independently: a rate-limit throw on window 20
  //     no longer discards windows 1-19 and restarts the whole fetch.
  const hospPropertyIds = Object.keys(propertyIdMap)

  const windows = hospPropertyIds.length
    ? hospReservationWindows(undefined, lookaheadMonths)
    : []

  const reservationsById = new Map<string, HospitableReservation>()

  for (const startDate of windows) {
    const windowReservations = await step.run(
      `fetch-reservations-window-${startDate}`,
      async () => fetchReservationsWindow(await getToken(), startDate, hospPropertyIds),
    )
    for (const r of windowReservations) reservationsById.set(r.id, r)
  }

  const reservations = Array.from(reservationsById.values())
  logger.info(`[Hospitable:${userId}] Fetched ${reservations.length} reservations across ${windows.length} windows`)

  return runReservationPipeline({
    step,
    logger,
    provider:     PROVIDER,
    orgId,
    userId,
    propertyIdMap,
    reservations: reservations.map(hospitableReservationToNormalized),
    system,
    revenueMode,
  })
}
