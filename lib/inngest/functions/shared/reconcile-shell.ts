// lib/inngest/functions/shared/reconcile-shell.ts
// ============================================================================
// The body every per-connection reservation reconcile handler shares.
//
// hospReservationReconcileHandler and hostexReservationReconcileHandler differ
// in exactly two places — how a token is obtained, and which sync to run — and
// were otherwise the same forty lines: read token, build the property map,
// skip when empty, sync, log, report-and-rethrow. SonarCloud measured the
// second one at 38.5% duplicated.
//
// The skip and the rethrow are the parts worth having in one place. A
// connection with no properties yet is NOT an error (its initial sync may
// still be running), and a reconcile that fails silently is precisely the
// failure these handlers exist to end — getting either backwards in one copy
// and not the other is the drift this prevents.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }     from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
import {
  fetchProviderPropertyIdMap,
  type ReservationProvider,
  type ReservationPipelineResult,
  type SyncLogger,
} from './reservation-pipeline'

type SyncStep = GetStepTools<typeof inngest>

export interface ProviderReconcileParams {
  step:     SyncStep
  logger:   SyncLogger
  provider: ReservationProvider
  /** Display form used in log lines, e.g. 'Hostex'. */
  label:    string
  userId:   string
  orgId:    string
  /** Names the RLS bypass for createServiceClient — see ServiceRoleContext. */
  system:   string
  /**
   * Acquires a CURRENT token. Throws NonRetriableError when the connection
   * needs reconnecting.
   *
   * Deliberately NOT resolved into a value here — see the "credentials are not
   * step state" note in lib/integrations/providers/hospitable-token.ts. This
   * used to be `await step.run('read-token', readToken)`, which memoized the
   * result: every retry of every downstream fetch step replayed the token the
   * first attempt happened to get, so a token invalidated mid-reconcile could
   * never be recovered from and the run burned its whole retry budget against
   * a credential one re-read would have fixed.
   */
  readToken: () => Promise<string>
  /** Runs the provider's own reservation sync against the resolved map. */
  sync: (getToken: () => Promise<string>, propertyIdMap: Record<string, string>) => Promise<ReservationPipelineResult>
}

export type ProviderReconcileResult =
  | { skipped: true; reason: string }
  | { properties: number; reservations: number; turnovers: number }

export async function runProviderReconcile(
  params: ProviderReconcileParams,
): Promise<ProviderReconcileResult> {
  const { step, logger, provider, label, userId, orgId, system, readToken, sync } = params

  try {
    const propertyIdMap = await step.run('fetch-property-map', () =>
      fetchProviderPropertyIdMap(orgId, provider, system))

    const propertyCount = Object.keys(propertyIdMap).length

    if (!propertyCount) {
      // Not an error: a connection whose initial sync has not finished — or
      // whose provider account genuinely has no properties — has nothing to
      // reconcile. Retrying would not create one.
      logger.info(`[${label}:${userId}] Reconcile skipped — no active ${label} properties`)
      return { skipped: true, reason: 'no_properties' }
    }

    const { reservationCount, newTurnoverIds } = await sync(readToken, propertyIdMap)

    logger.info(
      `[${label}:${userId}] Reservation reconcile complete — ` +
      `${propertyCount} properties, ${reservationCount} reservations, ` +
      `${newTurnoverIds.length} new turnovers`
    )

    return { properties: propertyCount, reservations: reservationCount, turnovers: newTurnoverIds.length }
  } catch (err) {
    // Report and rethrow. A reconcile that fails must surface and retry —
    // swallowing it here recreates the exact silence these handlers exist to
    // end, and for Hostex this is the last line of defence behind a webhook
    // path the provider never retries.
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`[${label}:${userId}] reservation reconcile failed: ${msg}`)
    reportError(err, { site: `inngest.${provider}-reservation-reconcile-handler`, orgId })
    throw err
  }
}
