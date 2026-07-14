import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

const MISSED_ASSIGNMENT_HOURS = 48

/**
 * SCHEDULED: runs nightly.
 *
 * assignment_outcomes has been write-only since it was introduced — nothing
 * ever read it back to move crew_members.reliability_score/capacity_score
 * off their static 1.0 defaults, despite both columns' comments describing
 * decay/recovery behavior. This closes that loop in two passes:
 *
 * 1. Flag turnovers that were assigned/in_progress long past checkout with
 *    no completion — a dropped assignment, not just a late one.
 * 2. apply_crew_score_recompute() (a SQL function, not JS here) atomically
 *    folds every not-yet-scored outcome into reliability_score and marks it
 *    scored in one transaction, then recomputes capacity_score from the
 *    all-time ratio of large- vs. small-property completions. Doing this in
 *    one DB function — rather than JS reading then writing across two
 *    separate loops — is what makes a mid-run failure safe to retry: the
 *    whole thing rolls back together, so a retry never re-derives a delta
 *    that was already partially applied.
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

    const { scored, crewUpdated, capacityUpdated } = await step.run('apply-score-deltas', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase.rpc('apply_crew_score_recompute')
      if (error) throw new Error(`apply_crew_score_recompute failed: ${error.message}`)
      return data as { scored: number; crewUpdated: number; capacityUpdated: number }
    })

    logger.info(
      `Crew score recompute: ${flagged} newly flagged missed, ${scored} outcomes scored ` +
      `(${crewUpdated} crew members updated), ${capacityUpdated} capacity scores updated`
    )

    return { flagged, scored, crewUpdated, capacityUpdated }
  }
)
