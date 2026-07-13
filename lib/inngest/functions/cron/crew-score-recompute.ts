import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

const MISSED_ASSIGNMENT_HOURS = 48
const LARGE_PROPERTY_BEDROOMS = 4
const MIN_CAPACITY_SAMPLE     = 3

interface ScoredOutcome {
  id:             string
  crew_member_id: string
  completed_at:   string | null
  pm_rating:      number | null
  was_missed:     boolean
  turnovers:      { checkin_datetime: string } | { checkin_datetime: string }[] | null
}

// Per-outcome reliability adjustment. Decays on late completions, missed
// assignments, or low PM ratings; recovers on on-time completions and high
// ratings — matching crew_members.reliability_score's column comment, which
// described this behavior long before any code actually implemented it.
function reliabilityDelta(input: { wasMissed: boolean; wasLate: boolean; pmRating: number | null }): number {
  if (input.wasMissed) return -0.15

  let delta = input.wasLate ? -0.05 : 0.02
  if (input.pmRating !== null) delta += (input.pmRating - 3) * 0.03
  return delta
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function resolveCheckinDatetime(turnovers: ScoredOutcome['turnovers']): string | null {
  const t = Array.isArray(turnovers) ? turnovers[0] : turnovers
  return t?.checkin_datetime ?? null
}

function computeReliabilityDeltas(outcomes: ScoredOutcome[]): {
  deltaByCrewId:   Record<string, number>
  outcomeUpdates:  { id: string; was_late: boolean | null }[]
} {
  const deltaByCrewId: Record<string, number> = {}
  const outcomeUpdates: { id: string; was_late: boolean | null }[] = []

  for (const o of outcomes) {
    const checkinAt = resolveCheckinDatetime(o.turnovers)
    const wasLate = !o.was_missed && !!o.completed_at && !!checkinAt
      ? new Date(o.completed_at) > new Date(checkinAt)
      : false

    const delta = reliabilityDelta({ wasMissed: o.was_missed, wasLate, pmRating: o.pm_rating })
    deltaByCrewId[o.crew_member_id] = (deltaByCrewId[o.crew_member_id] ?? 0) + delta
    outcomeUpdates.push({ id: o.id, was_late: o.was_missed ? null : wasLate })
  }

  return { deltaByCrewId, outcomeUpdates }
}

/**
 * SCHEDULED: runs nightly.
 *
 * assignment_outcomes has been write-only since it was introduced — nothing
 * ever read it back to move crew_members.reliability_score/capacity_score
 * off their static 1.0 defaults, despite both columns' comments describing
 * decay/recovery behavior. This closes that loop in three passes:
 *
 * 1. Flag turnovers that were assigned/in_progress long past checkout with
 *    no completion — a dropped assignment, not just a late one.
 * 2. Fold every not-yet-scored outcome (completed or missed) into the
 *    relevant crew member's reliability_score, then mark it scored so a
 *    re-run never double-applies the same delta.
 * 3. Recompute capacity_score from the all-time ratio of large- vs.
 *    small-property completions, once a crew member has enough history to
 *    make the ratio meaningful.
 */
export const crewScoreRecompute = inngest.createFunction(
  { id: 'cron-crew-score-recompute', name: 'Cron: Recompute Crew Reliability & Capacity Scores', retries: 2 },
  { cron: '0 9 * * *' }, // ~3-4am CT, off-hours
  async ({ step, logger }) => {
    const flagged = await step.run('flag-missed-assignments', async () => {
      const supabase = createServiceClient()
      const cutoff = new Date(Date.now() - MISSED_ASSIGNMENT_HOURS * 60 * 60 * 1000).toISOString()

      const { data: missedTurnovers } = await supabase
        .from('turnovers')
        .select('id, org_id, turnover_assignments(crew_member_id)')
        .in('status', ['assigned', 'in_progress'])
        .lt('checkout_datetime', cutoff)

      const rows = (missedTurnovers ?? []).flatMap((t) =>
        (t.turnover_assignments ?? []).map((a) => ({
          turnover_id:    t.id,
          org_id:         t.org_id,
          crew_member_id: a.crew_member_id,
          was_missed:     true,
        }))
      )

      if (!rows.length) return 0

      // ignoreDuplicates: false — needed to flip was_missed to true on a row
      // that may already exist from the original suggestion. Safe because
      // only was_missed is included in the payload, so no other column on an
      // existing row (suggested_score, score_breakdown, etc.) is touched.
      const { error } = await supabase.from('assignment_outcomes').upsert(rows, {
        onConflict:       'turnover_id,crew_member_id',
        ignoreDuplicates: false,
      })
      if (error) throw new Error(`Failed to flag missed assignments: ${error.message}`)
      return rows.length
    })

    const scored = await step.run('apply-score-deltas', async () => {
      const supabase = createServiceClient()

      const [{ data: completedRows }, { data: missedRows }] = await Promise.all([
        supabase
          .from('assignment_outcomes')
          .select('id, crew_member_id, completed_at, pm_rating, was_missed, turnovers(checkin_datetime)')
          .is('scored_at', null)
          .not('completed_at', 'is', null),
        supabase
          .from('assignment_outcomes')
          .select('id, crew_member_id, completed_at, pm_rating, was_missed, turnovers(checkin_datetime)')
          .is('scored_at', null)
          .eq('was_missed', true),
      ])

      // A row could in principle match both queries — dedupe by id.
      const byId = new Map<string, ScoredOutcome>()
      for (const o of [...(completedRows ?? []), ...(missedRows ?? [])]) byId.set(o.id, o)
      const outcomes = [...byId.values()]

      if (!outcomes.length) return 0

      const { deltaByCrewId, outcomeUpdates } = computeReliabilityDeltas(outcomes)

      const { data: crewRows } = await supabase
        .from('crew_members')
        .select('id, reliability_score')
        .in('id', Object.keys(deltaByCrewId))

      for (const c of crewRows ?? []) {
        const current = c.reliability_score !== null ? Number(c.reliability_score) : 1.0
        const next    = clamp01(current + (deltaByCrewId[c.id] ?? 0))
        await supabase.from('crew_members').update({ reliability_score: next }).eq('id', c.id)
      }

      const now = new Date().toISOString()
      for (const u of outcomeUpdates) {
        await supabase.from('assignment_outcomes').update({ scored_at: now, was_late: u.was_late }).eq('id', u.id)
      }

      return outcomes.length
    })

    const capacityUpdated = await step.run('recompute-capacity-scores', async () => {
      const supabase = createServiceClient()

      const { data: outcomes } = await supabase
        .from('assignment_outcomes')
        .select('crew_member_id, property_bedrooms')
        .not('property_bedrooms', 'is', null)
        .not('completed_at', 'is', null)

      const byCrewId: Record<string, { large: number; total: number }> = {}
      for (const o of outcomes ?? []) {
        const bucket = byCrewId[o.crew_member_id] ?? { large: 0, total: 0 }
        bucket.total += 1
        if ((o.property_bedrooms ?? 0) >= LARGE_PROPERTY_BEDROOMS) bucket.large += 1
        byCrewId[o.crew_member_id] = bucket
      }

      let updated = 0
      for (const [crewMemberId, { large, total }] of Object.entries(byCrewId)) {
        if (total < MIN_CAPACITY_SAMPLE) continue
        const capacityScore = Math.round((large / total) * 1000) / 1000
        await supabase.from('crew_members').update({ capacity_score: capacityScore }).eq('id', crewMemberId)
        updated++
      }
      return updated
    })

    logger.info(
      `Crew score recompute: ${flagged} newly flagged missed, ${scored} outcomes scored, ${capacityUpdated} capacity scores updated`
    )

    return { flagged, scored, capacityUpdated }
  }
)
