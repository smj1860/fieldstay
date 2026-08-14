// lib/dexie/sync/full-resync.ts
//
// The single full-scope pull of every Supabase-backed table the crew PWA
// caches. Both sync paths in lib/dexie/context.tsx — v1 (postgres_changes)
// and v2 (broadcast signal + delta pull) — run THIS function on mount, on
// reconnect, and on the safety-poll interval, so the Crew Sync v2 coverage
// convention (CLAUDE.md; docs/CREW_SYNC_V2_PHASES.md section 5e) holds under
// whichever path actually ships, not only under the flag-on one.
//
// Before this existed, v1 and v2 each had their own resync body and only v2
// had a safety poll at all — so the crew-sync-coverage guardrail asserted a
// mechanism that was not running in the shipping (flag-off) configuration.

import type { DexieSupabaseClient } from './types'
import { syncAssignedTurnovers } from './turnovers'
import { syncWorkOrders } from './work-orders'
import { computeAssignedPropertyIds, syncPropertyAssets } from './assets'
import { resetAllCursors, recordSyncSuccess } from './cursors'
import { pruneLocalCache } from '../prune'
import { warmCrewRouteCache } from './warm-routes'

/**
 * Which sync function covers each Dexie table in
 * `CREW_SYNCED_TABLES` (lib/dexie/schema.ts). Asserted against that map by
 * unit/guardrails/crew-sync-coverage.test.ts, which also checks each name
 * below is actually called in this file — so a table added to the schema
 * without a pull here fails CI.
 */
export const CREW_RESYNC_COVERAGE: Readonly<Record<string, string>> = {
  turnovers:                'syncAssignedTurnovers',
  checklist_instances:      'syncAssignedTurnovers',
  checklist_instance_items: 'syncAssignedTurnovers',
  inventory_items:          'syncAssignedTurnovers',
  properties:               'syncAssignedTurnovers',
  crew_work_orders:         'syncWorkOrders',
  property_assets:          'syncPropertyAssets',
}

/**
 * Pulls every cached entity for this crew member and prunes what's fallen
 * out of scope. Correctness backstop for anything a Realtime event or
 * broadcast signal missed — cursors keep it cheap (see ./cursors.ts), scope
 * reconciliation inside each sync function keeps it correct.
 */
export async function fullCrewResync(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
  opts: { reconcile?: boolean } = {},
): Promise<void> {
  await Promise.all([
    syncAssignedTurnovers(supabase, userId, crewMemberId),
    // `reconcile` costs work_orders one extra query (the membership snapshot),
    // which only reassignment-away needs. Passed on the events where a device
    // may have missed a broadcast — mount, reconnect, foreground, signal — and
    // periodically from the safety poll, not on every tick.
    syncWorkOrders(supabase, userId, crewMemberId, false, opts.reconcile ?? false),
  ])

  // property_assets deliberately has no broadcast trigger — this is its only
  // freshness path (docs/CREW_SYNC_V2_PHASES.md section 1). Derived from the
  // turnover/WO scope just pulled above, so it runs after, not in parallel.
  const propertyIds = await computeAssignedPropertyIds(userId)
  await syncPropertyAssets(supabase, userId, propertyIds)

  await pruneLocalCache(userId)

  // Only here — after every entity landed and the prune ran — does a resync
  // count as successful. The crew home screen reads this to tell "nothing is
  // assigned to you" apart from "this device has never synced", which it
  // previously rendered identically.
  await recordSyncSuccess(userId)

  // The DATA is offline-ready the moment the pulls above land. The page
  // DOCUMENT for /crew/turnovers/<id> is not — sw.js only caches a URL that
  // has actually been navigated to, and that URL is first visited at the
  // property, which is exactly where the signal isn't. Warm it here, where we
  // know both the assignment scope and that the network is currently up.
  await warmCrewRouteCache(userId)
}

/**
 * fullCrewResync with every delta cursor rewound first, so the next pull
 * transfers whole rows instead of "what changed since".
 *
 * The repair path for a device whose cache has diverged from the server.
 * There was none: `force` was plumbed through every sync function but never
 * passed as `true` from anywhere in the app, and nothing ever reset a cursor —
 * so once a row was masked by a local write that was later abandoned, the
 * delta filter would skip it forever and the only way out was logout, which
 * destroys the outbox along with the cache.
 */
export async function forceFullCrewResync(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
): Promise<void> {
  await resetAllCursors(userId)
  await fullCrewResync(supabase, userId, crewMemberId)
}
