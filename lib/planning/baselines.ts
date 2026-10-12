import 'server-only'

import type { createServiceClient } from '@/lib/supabase/server'
import { unwrapList } from '@/lib/supabase/unwrap'

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * crew_speed_baselines, loaded once per org.
 *
 * Shared by the day planner and the cascade-alert cron rather than copied
 * into each. Both need the same two things from the same table: this crew
 * member's own minutes-per-bedroom, and a median to stand in for everyone
 * who has no row (under three completed turnovers in the 90-day window gets
 * no baseline at all, by design — see CLAUDE.md on crew_speed_baselines).
 */
export interface Baselines {
  byCrew: Map<string, number>
  median: number | null
}

/**
 * The same data in a form that survives an Inngest step boundary.
 *
 * A Map does not: step.run()'s return value is JSON-serialized, so a Map
 * comes back from a memoized step as `{}`. Loading returns this, and
 * resolveBaselines() rebuilds the Map on the far side.
 */
export interface SerializableBaselines {
  byCrew: readonly (readonly [string, number])[]
  median: number | null
}

export function medianOf(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function resolveBaselines(serialized: SerializableBaselines): Baselines {
  return { byCrew: new Map(serialized.byCrew), median: serialized.median }
}

export async function loadCrewBaselines(
  supabase: ServiceClient,
  orgId:    string,
): Promise<SerializableBaselines> {
  // Bounded by the org's crew count, which is plan-capped.
  const res = await supabase
    .from('crew_speed_baselines')
    .select('crew_member_id, avg_minutes_per_bedroom')
    .eq('org_id', orgId)
    .limit(500)

  const rows = unwrapList<{ crew_member_id: string; avg_minutes_per_bedroom: number | string | null }>(
    res, { site: 'lib.planning.baselines', orgId },
  )

  const perBedroom = rows
    .map((r) => (r.avg_minutes_per_bedroom === null ? null : Number(r.avg_minutes_per_bedroom)))
    .filter((n): n is number => n !== null && Number.isFinite(n) && n > 0)

  return {
    byCrew: rows
      .filter((r) => r.avg_minutes_per_bedroom !== null)
      .map((r) => [r.crew_member_id, Number(r.avg_minutes_per_bedroom)] as const),
    median: medianOf(perBedroom),
  }
}
