import { unwrap } from '@/lib/supabase/unwrap'
import type { createClient } from '@/lib/supabase/server'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Org scoping alone lets ANY active crew member in the org act on ANY
 * turnover in it (start, complete) — not just ones assigned to them. That
 * misattributes crew-duration/completion data to crewScoreRecompute and
 * assignment_outcomes. Callers should 404 (not 403) on a false result, the
 * same response an unknown turnover id gets — an unassigned crew member
 * should not learn the id exists.
 */
export async function isCrewAssignedToTurnover(
  supabase: SupabaseServerClient,
  turnoverId: string,
  crewMemberId: string,
): Promise<boolean> {
  // Callers answer `false` with a 404, and lib/dexie/net.ts treats 4xx as
  // TERMINAL — so a failed read here discarded the crew member's queued
  // start/complete permanently. Throw instead: the route 500s, which the
  // outbox retries, and the check still fails closed.
  const assignmentRes = await supabase
    .from('turnover_assignments')
    .select('id')
    .eq('turnover_id',    turnoverId)
    .eq('crew_member_id', crewMemberId)
    .maybeSingle()

  return unwrap(assignmentRes, { site: 'lib.turnovers.isCrewAssignedToTurnover' }) !== null
}
