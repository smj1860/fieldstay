import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { unwrapList } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { topFrictionReasons, type FrictionComponents } from '@/lib/scoring/friction'

/**
 * Bound on the panel's read.
 *
 * One row per turnover per day, and a turnover count for one day is bounded by
 * the portfolio — 150 properties is the self-serve ceiling, so this cannot be
 * reached in practice. Explicit anyway: `max_rows` truncates at 1000 with a
 * 200 and no signal, and a silently short list here reads as "fewer turnovers
 * are at risk than really are", which is the exact failure the feature exists
 * to prevent.
 */
const FLAGGED_LIMIT = 300

export interface FlaggedTurnover {
  id:                  string
  turnoverId:          string
  propertyName:        string | null
  checkoutDatetime:    string | null
  failureProbability:  number
  severity:            'high' | 'critical'
  /** Deterministic, template-built from the breakdown — never LLM-generated. */
  reasons:             string[]
  smartFixCrewId:      string | null
  smartFixCrewName:    string | null
  smartFixReasoning:   string | null
}

interface FrictionRow {
  id:                  string
  turnover_id:         string
  failure_probability: number | string
  severity:            string
  score_breakdown:     Partial<Record<keyof FrictionComponents, number>> | null
  smart_fix_crew_id:   string | null
  smart_fix_reasoning: string | null
  properties:          unknown
  turnovers:           unknown
  crew_members:        unknown
}

function toFlagged(row: FrictionRow): FlaggedTurnover {
  const property = unwrapJoin(row.properties)    as { name?: string } | null
  const turnover = unwrapJoin(row.turnovers)     as { checkout_datetime?: string } | null
  const crew     = unwrapJoin(row.crew_members)  as { name?: string } | null

  return {
    id:                 row.id,
    turnoverId:         row.turnover_id,
    propertyName:       property?.name ?? null,
    checkoutDatetime:   turnover?.checkout_datetime ?? null,
    // PostgREST returns numeric as a string.
    failureProbability: Number(row.failure_probability),
    severity:           row.severity === 'critical' ? 'critical' : 'high',
    reasons:            topFrictionReasons(row.score_breakdown ?? {}),
    smartFixCrewId:     row.smart_fix_crew_id,
    smartFixCrewName:   crew?.name ?? null,
    smartFixReasoning:  row.smart_fix_reasoning,
  }
}

/**
 * Today's flagged turnovers for one org, worst first.
 *
 * Scoped to `turnoverDate` rather than reading every flagged row ever written:
 * a flag is a statement about ONE day's schedule, and yesterday's — which
 * nobody can act on any more — would otherwise pile up on the panel and bury
 * the ones that still matter.
 *
 * Returns `[]` for an org with nothing flagged; a failed READ throws, via
 * unwrapList. Collapsing those two would render a real outage as a clean
 * dashboard, which is the worst possible way for this feature to fail.
 */
export async function loadFlaggedTurnovers(
  supabase:     SupabaseClient,
  orgId:        string,
  turnoverDate: string,
): Promise<FlaggedTurnover[]> {
  const res = await supabase
    .from('pre_flight_friction')
    .select(`
      id, turnover_id, failure_probability, severity, score_breakdown,
      smart_fix_crew_id, smart_fix_reasoning,
      properties ( name ),
      turnovers ( checkout_datetime ),
      crew_members ( name )
    `)
    .eq('org_id', orgId)
    .eq('turnover_date', turnoverDate)
    .eq('status', 'flagged')
    .order('failure_probability', { ascending: false })
    .limit(FLAGGED_LIMIT)

  return unwrapList<FrictionRow>(res, { site: 'ops.loadFlaggedTurnovers', orgId }).map(toFlagged)
}
