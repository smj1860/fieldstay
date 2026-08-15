// lib/inngest/functions/hospitable/connection-dispatch.ts
// ============================================================
// The dispatch-per-connection body shared by the Hospitable connection crons.
//
// hospTeammateSyncCron and hospReservationReconcileCron are the same function
// with four strings changed: find every active Hospitable connection, and send
// one event per connection. Written out twice, the copies were ~40 identical
// lines each — SonarQube put the second one at 43% duplicated on the PR that
// introduced it, which is what prompted this extraction.
//
// The duplication mattered beyond tidiness: the `fetchAllRows` pagination is
// load-bearing (a platform-wide scan truncating at max_rows would silently
// stop dispatching for every connection past 1000 while still reporting
// success), and a second copy is a second place for that to be got wrong or
// quietly reverted.
//
// Step ids are parameters rather than constants because Inngest memoizes on
// them: 'fetch-active-connections' is genuinely identical in both callers and
// stays shared, but each caller keeps its own dispatch step id so a run in
// flight across the deploy resumes rather than replaying.
// ============================================================

import type { GetStepTools } from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'

const PROVIDER = 'hospitable'

type CronStep = GetStepTools<typeof inngest>

interface CronLogger {
  info: (msg: string) => void
}

/** The three fields every per-connection Hospitable event carries. */
export interface HospitableConnectionRow {
  user_id:          string
  org_id:           string | null
  external_user_id: string | null
}

export interface DispatchParams {
  step:   CronStep
  logger: CronLogger
  /** Names the RLS bypass — see ServiceRoleContext. */
  system: string
  /** fetchAllRows label, for pagination diagnostics. */
  label:  string
  /** Inngest step id for the sendEvent. Distinct per caller — see header. */
  dispatchStepId: string
  /** Event each connection receives. */
  eventName: 'integration/hospitable.teammate_sync.requested'
           | 'integration/hospitable.reservation_reconcile.requested'
  /** Prefix for the one log line, e.g. '[Hospitable teammate-sync cron]'. */
  logPrefix: string
}

/**
 * Finds every active Hospitable connection and sends one event per connection.
 *
 * Returns the dispatch count so each cron can return it as its own result.
 */
export async function dispatchPerHospitableConnection(
  params: DispatchParams,
): Promise<{ dispatched: number }> {
  const { step, logger, system, label, dispatchStepId, eventName, logPrefix } = params

  const connections = await step.run('fetch-active-connections', async () => {
    const supabase = createServiceClient({ system })

    // PLATFORM-WIDE scan — every org with a live Hospitable connection, not
    // one tenant's. At max_rows = 1000 PostgREST returns the first 1000 with
    // a 200 and no truncation signal, so every connection past that would
    // stop being dispatched entirely while the cron still reported success.
    //
    // org_id NOT NULL is required, not merely tidy: every consumer scopes its
    // reads and writes by it, and a connection without one has nothing to act
    // on.
    return await fetchAllRows<HospitableConnectionRow>(
      (from, to) => supabase
        .from('integration_connections')
        .select('user_id, org_id, external_user_id')
        .eq('provider_id', PROVIDER)
        .eq('status',      'active')
        .not('org_id',     'is', null)
        .order('user_id')
        .range(from, to),
      { label },
    )
  })

  logger.info(`${logPrefix} Dispatching for ${connections.length} connections`)

  if (connections.length === 0) return { dispatched: 0 }

  await step.sendEvent(
    dispatchStepId,
    connections.map((c) => ({
      name: eventName,
      data: {
        user_id:          c.user_id,
        org_id:           c.org_id!,
        external_user_id: c.external_user_id ?? '',
      },
    })),
  )

  return { dispatched: connections.length }
}
