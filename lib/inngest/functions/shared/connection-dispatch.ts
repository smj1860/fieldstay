// lib/inngest/functions/shared/connection-dispatch.ts
// ============================================================================
// The dispatch-per-connection body shared by every PMS connection cron.
//
// Four crons across three providers are the same function with a handful of
// strings changed: find every active connection for one provider, and send one
// event per connection.
//
//   hospitable/teammate-sync-cron.ts
//   hospitable/reservation-reconcile-cron.ts
//   hostex/reservation-reconcile-cron.ts
//   hostaway/reservation-reconcile-cron.ts
//
// This started as hospitable/connection-dispatch.ts, extracted when SonarQube
// put the SECOND Hospitable copy at 43% duplicated. Hostex and Hostaway were
// then each written as a fresh copy of the pre-extraction shape rather than as
// callers of it — the Hostaway cron came back at 35.6% duplicated against the
// Hostex one, 31 identical lines. Moving it here and widening it by one
// `provider` parameter is what actually stops that recurring, since the reason
// it recurred is that the abstraction lived in a provider's own folder and so
// read as Hospitable's private helper.
//
// The duplication matters beyond tidiness: the `fetchAllRows` pagination is
// load-bearing. A platform-wide scan truncating at PostgREST's max_rows = 1000
// returns a 200 with no truncation signal, so every connection past the
// thousandth would silently stop being dispatched while the cron still
// reported success — and each copy is another place for that to be got wrong
// or quietly reverted.
//
// Step ids are parameters rather than constants because Inngest memoizes on
// them: 'fetch-active-connections' is genuinely identical across all callers
// and stays shared, but each caller keeps its own dispatch step id so a run in
// flight across the deploy resumes rather than replaying.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { sendEventsChunked }  from '@/lib/inngest/chunk'
import { createServiceClient } from '@/lib/supabase/server'
import { SYNCABLE_CONNECTION_STATUSES } from '@/lib/integrations/connection-metadata'

type CronStep = GetStepTools<typeof inngest>

interface CronLogger {
  info: (msg: string) => void
}

/** The three fields every per-connection cron event carries. */
export interface ProviderConnectionRow {
  user_id:          string
  org_id:           string | null
  external_user_id: string | null
}

/**
 * The per-connection cron events, spelled out rather than widened to `string`.
 *
 * Inngest's EventSchemas already type-checks `inngest.send()`, but this
 * function builds the payload generically, so without the union a typo would
 * only surface at runtime as an event nothing is subscribed to — a cron that
 * reports "dispatched: 40" and does nothing. Add the literal here when adding
 * a cron.
 */
export type ConnectionDispatchEvent =
  | 'integration/hospitable.teammate_sync.requested'
  | 'integration/hospitable.reservation_reconcile.requested'
  | 'integration/hostex.reservation_reconcile.requested'
  | 'integration/hostaway.reservation_reconcile.requested'

export interface DispatchParams {
  step:   CronStep
  logger: CronLogger
  /** integration_connections.provider_id to scan for. */
  provider: 'hospitable' | 'hostex' | 'hostaway'
  /** Names the RLS bypass — see ServiceRoleContext. */
  system: string
  /** fetchAllRows label, for pagination diagnostics. */
  label:  string
  /** Inngest step id for the sendEvent. Distinct per caller — see header. */
  dispatchStepId: string
  /** Event each connection receives. */
  eventName: ConnectionDispatchEvent
  /** Prefix for the one log line, e.g. '[Hostaway reconcile cron]'. */
  logPrefix: string
  /**
   * When set, spreads dispatch across this many seconds instead of sending
   * every event for the same instant. Each connection gets a DETERMINISTIC
   * offset (hashed from its user id, same technique as
   * hostaway/incremental-sync-cron.ts's jitterSecondsForConnection) into
   * `[0, jitterWindowSeconds)`, carried on the event's own future `ts` rather
   * than a step.sleep — so N connections cost N scheduled events, not N
   * function runs parked in a sleep.
   *
   * Omit (the default) to send every event at the current instant, unchanged
   * behaviour for callers that don't need it (teammate-sync, hostex/hostaway
   * reconcile — see hospitable-reservation-reconcile-cron.ts for why THAT one
   * needs it: a shared, platform-wide external rate-limit budget that every
   * connection's daily reconcile competes for).
   */
  jitterWindowSeconds?: number
}

/**
 * A stable per-connection offset into `[0, windowSeconds)`.
 *
 * DETERMINISTIC, not random, and deliberately the same FNV-1a technique as
 * hostaway/incremental-sync-cron.ts's jitterSecondsForConnection — see that
 * file's doc comment for why determinism matters (a replayed Inngest run
 * must compute the same offset, and a random one would make the interval
 * between a connection's own runs drift rather than stay stable). Not
 * shared code with that file: the two crons differ in exactly one axis (the
 * window width — an hour there vs. many hours here), and duplicating one
 * small pure function is cheaper than adding a parameter to a file this
 * PR is not otherwise touching.
 */
function jitterSecondsForConnection(userId: string, windowSeconds: number): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % windowSeconds
}

/**
 * Finds every active connection for one provider and sends one event each.
 *
 * Returns the dispatch count so each cron can return it as its own result.
 */
export async function dispatchPerProviderConnection(
  params: DispatchParams,
): Promise<{ dispatched: number }> {
  const { step, logger, provider, system, label, dispatchStepId, eventName, logPrefix, jitterWindowSeconds } = params

  const connections = await step.run('fetch-active-connections', async () => {
    const supabase = createServiceClient({ system })

    // PLATFORM-WIDE scan — every org with a live connection to this provider,
    // not one tenant's. At max_rows = 1000 PostgREST returns the first 1000
    // with a 200 and no truncation signal, so every connection past that would
    // stop being dispatched entirely while the cron still reported success.
    //
    // org_id NOT NULL is required, not merely tidy: every consumer scopes its
    // reads and writes by it, and a connection without one has nothing to act
    // on.
    return await fetchAllRows<ProviderConnectionRow>(
      (from, to) => supabase
        .from('integration_connections')
        .select('user_id, org_id, external_user_id')
        .eq('provider_id', provider)
        // Includes 'error'. This dispatches the daily reconcile — the sweep
        // that RECOVERS a connection whose webhooks or incremental sync have
        // been failing — so excluding errored rows would mean the one thing
        // able to catch a tenant up is the one thing that stops running for
        // them. Hostaway matters most here: its API key cannot be refreshed, so
        // there is no token-refresh path to heal it separately. 'revoked' stays
        // out. See SYNCABLE_CONNECTION_STATUSES.
        .in('status',      [...SYNCABLE_CONNECTION_STATUSES])
        .not('org_id',     'is', null)
        .order('user_id')
        .range(from, to),
      { label },
    )
  })

  logger.info(`${logPrefix} Dispatching for ${connections.length} connections`)

  if (connections.length === 0) return { dispatched: 0 }

  // Chunked, not one call for the whole platform: Inngest enforces a
  // per-call event-count/payload ceiling, and a single call built from a
  // platform-wide connection scan risks being rejected or truncated
  // ATOMICALLY the moment that scan crosses it — failing dispatch for every
  // tenant in this batch, not just the ones past the limit.
  const now = Date.now()

  await sendEventsChunked(
    step,
    dispatchStepId,
    connections.map((c) => ({
      name: eventName,
      // Only set when jitterWindowSeconds is configured — an explicit `ts`
      // in the past or present is a no-op for Inngest, but leaving the key
      // off entirely for the unjittered callers keeps their event payloads
      // byte-identical to before this change.
      ...(jitterWindowSeconds != null
        ? { ts: now + jitterSecondsForConnection(c.user_id, jitterWindowSeconds) * 1000 }
        : {}),
      data: {
        user_id:          c.user_id,
        org_id:           c.org_id!,
        external_user_id: c.external_user_id ?? '',
      },
    })),
  )

  return { dispatched: connections.length }
}
