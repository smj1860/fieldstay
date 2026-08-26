// lib/inngest/functions/shared/revoke-and-notify.ts
// ============================================================================
// The whole "the provider stopped accepting this connection" sequence, once.
//
// ── Why this is shared, having deliberately not been at first ───────────────
//
// Six handlers across three providers each carried ~35 lines of identical step
// scaffolding: mark-revoked, sendEvent, record-notified, reportError, warn.
// SonarCloud scored the result at 25.5% duplicated lines on new code, with the
// worst file at 88.5%, and it was right to.
//
// The duplication was not accidental — it was a reading of CLAUDE.md's ban on
// step tooling inside a step.run callback, which is what let ownerrez-reviews-
// sync nest a send invisibly and write two audit rows per revocation. But that
// ban is about NESTING, not about sharing: a helper that takes `step` and is
// invoked at the FUNCTION'S TOP LEVEL is not nested, and this directory already
// contains one (reconcile-shell.ts's runProviderReconcile, same signature
// shape). Copying the sequence six times bought nothing the ban asks for and
// cost exactly what CLAUDE.md warns duplication costs: connection-error-
// notify.ts's own header records that the OwnerRez copies "both carried the
// same defect ... the second copy did not get fixed when the first was looked
// at".
//
// ── The one rule that still applies ─────────────────────────────────────────
//
// CALL THIS AT THE TOP LEVEL OF AN INNGEST FUNCTION, NEVER INSIDE A step.run
// CALLBACK. It performs step tooling; invoking it mid-callback registers a new
// step op, unwinds the request, and re-runs the enclosing callback from the top
// on the next pass — replaying every side effect written before the call.
// unit/guardrails/connection-revoked-notify.test.ts asserts no call site does
// that, which is the invariant that actually matters and a stricter check than
// the "the helper never mentions step" rule it replaces.
//
// The DECISION still comes out of its own step.run, and the send still sits
// between two steps rather than inside one. That structure is unchanged; only
// its address is.
// ============================================================================

import type { GetStepTools } from 'inngest'

import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { recordConnectionErrorNotified } from '@/lib/integrations/connection-error-notify'
import { markProviderConnectionRevoked } from '@/lib/integrations/connection-revoked'
import type { SyncLogger } from '@/lib/inngest/functions/shared/reservation-pipeline'

type SyncStep = GetStepTools<typeof inngest>

export interface RevokeAndNotifyParams {
  step:   SyncStep
  logger: SyncLogger
  userId: string
  orgId:  string
  /** integration_connections.provider_id, e.g. 'hostex'. */
  providerId: string
  /** How the provider is named to the PM and in logs, e.g. 'Hostex'. */
  providerLabel: string
  /** The failure that proved the connection dead. */
  err: unknown
  /** Names the RLS bypass for createServiceClient — see ServiceRoleContext. */
  system: string
  /**
   * The Inngest function id, used to build `site` strings and to keep every
   * step id in this sequence unique per function. Two functions in one run
   * would otherwise collide on 'mark-revoked'.
   */
  fnId: string
}

/**
 * Revoke the connection, tell the PM once, and report it once.
 *
 * Returns nothing: every caller's next line is its own "paused" return value,
 * and the shapes differ per handler.
 */
export async function revokeAndNotify(params: RevokeAndNotifyParams): Promise<void> {
  const { step, logger, userId, orgId, providerId, providerLabel, err, system, fnId } = params

  // Decision only. The send is deliberately NOT in here — see the header.
  const decision = await step.run(`${fnId}-mark-revoked`, async () => {
    const admin = createServiceClient({ system })
    return markProviderConnectionRevoked(admin, {
      userId, orgId, providerId, providerLabel, err,
      site: `inngest.${fnId}.notify-revoked.throttle`,
    })
  })

  if (decision) {
    await step.sendEvent(`${fnId}-notify-revoked`, {
      name: 'integration/connection.error',
      data: { user_id: userId, org_id: orgId, provider_id: providerId, reason: decision.humanError },
    })

    // Its own step, deliberately: a failure here retries just this write, with
    // the send already memoized, so it can neither duplicate the notification
    // nor replay the audit event written during mark-revoked.
    await step.run(`${fnId}-record-revoked-notified`, async () => {
      const admin = createServiceClient({ system })
      await recordConnectionErrorNotified(admin, {
        orgId,
        connectionId: decision.connectionId,
        site: `inngest.${fnId}.notify-revoked.record`,
      })
    })
  }

  // Reported once, not every run. Revoking removes this connection from
  // SYNCABLE_CONNECTION_STATUSES, so the cron stops fanning to it — which is
  // the difference between one alert and the hourly repeat that made the
  // original Sentry cluster unreadable.
  reportError(err instanceof Error ? err : new Error(String(err)), {
    site:  `inngest.${fnId}.connection-revoked`,
    orgId,
  })

  logger.warn(
    `[${providerLabel}] org ${orgId}: connection revoked by the provider — ` +
    `sync paused until the PM reconnects`
  )
}
