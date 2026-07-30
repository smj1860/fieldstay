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
import { syncMessages } from './messages'
import { syncCrewAvailability } from './availability'
import { computeAssignedPropertyIds, syncPropertyAssets } from './assets'
import { pruneLocalCache } from '../prune'

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
  messages:                 'syncMessages',
  crew_availability:        'syncCrewAvailability',
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
): Promise<void> {
  await Promise.all([
    syncAssignedTurnovers(supabase, userId, crewMemberId),
    syncWorkOrders(supabase, userId, crewMemberId),
    syncMessages(supabase, userId),
    syncCrewAvailability(supabase, userId, crewMemberId),
  ])

  // property_assets deliberately has no broadcast trigger — this is its only
  // freshness path (docs/CREW_SYNC_V2_PHASES.md section 1). Derived from the
  // turnover/WO scope just pulled above, so it runs after, not in parallel.
  const propertyIds = await computeAssignedPropertyIds(userId)
  await syncPropertyAssets(supabase, userId, propertyIds)

  await pruneLocalCache(userId)
}
