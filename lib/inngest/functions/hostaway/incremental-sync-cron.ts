// lib/inngest/functions/hostaway/incremental-sync-cron.ts
// ============================================================================
// Hourly cron — dispatches one incremental-sync event per active Hostaway
// connection.
//
// ── Why this exists instead of webhooks ─────────────────────────────────────
//
// Hostaway CAN deliver webhooks — they are created per account from the
// dashboard or "a public API request" — but its public API reference documents
// no unified-webhook endpoint and no payload schema at all (checked
// 2026-08-18: the only webhook page in the whole reference is a conversation-
// message delivery LOG). Without a payload shape there is no way to know which
// field names a delivery carries, and the field that matters most is whichever
// one identifies the ACCOUNT — get that wrong and a delivery is attributed to
// an arbitrary connected org, which is the cross-tenant misattribution
// hospitable-owner.ts exists to prevent. So: no webhook, and no guessing.
//
// This closes the same gap a different way. GET /reservations accepts
// `latestActivityStart`, a genuine changed-since filter, so an hourly sweep
// gets a Hostaway org to within the hour of live without any push channel.
// That is strictly better than what a webhook would have bought us anyway,
// because Hostaway documents its webhook payloads as INCOMPLETE ("data that
// come in later are not provided") and recommends re-reading through the API —
// so the API read was always going to be the source of truth.
//
// The daily reconcile stays. The two answer different questions: this sweeps
// by CHANGE (catching a cancellation of a stay next spring), the reconcile
// sweeps by ARRIVAL DATE (catching anything the change feed missed, and
// re-reading reviews). Neither subsumes the other.
//
// ── The jitter ──────────────────────────────────────────────────────────────
//
// The dispatch is deliberately NOT all at once. See jitterSecondsForConnection.
// ============================================================================

import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { SYNCABLE_CONNECTION_STATUSES } from '@/lib/integrations/connection-metadata'

const PROVIDER = 'hostaway'
const SYSTEM   = 'inngest:hostaway-incremental-sync-cron'

/** The window the fan-out is spread across, just under the hourly period. */
export const JITTER_WINDOW_SECONDS = 55 * 60

interface HostawayConnectionRow {
  user_id:          string
  org_id:           string | null
  external_user_id: string | null
}

/**
 * A stable per-connection offset into the hour, in seconds.
 *
 * DETERMINISTIC, not random, and that is the point. A random delay would give
 * the same average spread but a different one each hour, so a connection could
 * sync at :05 and then at :58 — a 113-minute gap on an "hourly" sync, and two
 * runs 7 minutes apart the next time. Hashing the user id instead means each
 * connection lands at roughly the same minute every hour: the interval between
 * a connection's own runs stays ~60 minutes, the cadence is predictable when
 * someone asks why a booking took 40 minutes to appear, and a replayed Inngest
 * run computes the same offset rather than drifting.
 *
 * Why spread at all: Hostaway rate-limits per account token, so connections do
 * not contend with each other there — but they DO contend for our own outbound
 * capacity and for Postgres. A hundred connections all waking on the hour is a
 * hundred simultaneous paginated fetches and a hundred concurrent upsert
 * pipelines, which is a self-inflicted thundering herd on a schedule.
 *
 * FNV-1a over the user id: not for cryptographic quality (a rate-limit offset
 * needs none) but because it is stable across processes and deploys, which
 * Math.random and any hash seeded per-process are not.
 */
export function jitterSecondsForConnection(userId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % JITTER_WINDOW_SECONDS
}

export const hostawayIncrementalSyncCron = inngest.createFunction(
  {
    id:      'hostaway-incremental-sync-cron',
    name:    'Hostaway: Hourly Incremental Sync Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hostaway-incremental-sync-cron"' },
  },
  // Minute 7, not 0: the top of the hour is where every other hourly job in
  // this codebase and in Vercel's scheduler already sits. The per-connection
  // jitter spreads the fan-out, but the SCAN itself still runs at one instant.
  { cron: '7 * * * *' },
  async ({ step, logger }) => {
    const connections = await step.run('fetch-active-connections', async () => {
      const supabase = createServiceClient({ system: SYSTEM })

      // PLATFORM-WIDE scan — every org with a live Hostaway connection. At
      // max_rows = 1000 PostgREST returns the first 1000 with a 200 and no
      // truncation signal, so every connection past that would silently stop
      // syncing while the cron still reported success.
      //
      // Includes 'error' (SYNCABLE_CONNECTION_STATUSES): a failed sweep must
      // not remove a connection from the sweep that would recover it. Hostaway
      // has no token refresh at all — its API key cannot be renewed — so there
      // is no separate healing path the way there is for the OAuth providers.
      return fetchAllRows<HostawayConnectionRow>(
        (from, to) => supabase
          .from('integration_connections')
          .select('user_id, org_id, external_user_id')
          .eq('provider_id', PROVIDER)
          .in('status',      [...SYNCABLE_CONNECTION_STATUSES])
          .not('org_id',     'is', null)
          .order('user_id')
          .range(from, to),
        { label: 'hostaway-incremental-sync-cron.connections' },
      )
    })

    logger.info(`[Hostaway incremental cron] Dispatching for ${connections.length} connections`)

    if (connections.length === 0) return { dispatched: 0 }

    // NOT dispatchPerProviderConnection: that helper sends every event at once,
    // which is right for the daily reconcile and is precisely what the jitter
    // exists to avoid here. The delay is carried by Inngest's own scheduler
    // (`ts` in the future) rather than a step.sleep in the handler, so a
    // hundred connections cost a hundred scheduled events instead of a hundred
    // function runs parked in a sleep for up to an hour.
    const now = Date.now()

    await step.sendEvent(
      'dispatch-incremental-events',
      connections.map((c) => ({
        name: 'integration/hostaway.incremental_sync.requested' as const,
        ts:   now + jitterSecondsForConnection(c.user_id) * 1000,
        data: {
          user_id:          c.user_id,
          org_id:           c.org_id!,
          external_user_id: c.external_user_id ?? '',
        },
      })),
    )

    return { dispatched: connections.length }
  }
)
