import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * SCHEDULED: grades yesterday's friction forecasts against what actually
 * happened.
 *
 * Every turnover gets a pre_flight_friction row each morning, not just the
 * flagged ones, so this measures the forecaster in BOTH directions. A turnover
 * predicted 'none' that ran late is a FALSE NEGATIVE — false confidence given
 * to a PM — and that is the failure the calibration view leads with. Nothing
 * here filters by predicted severity.
 *
 * 11:00 UTC, ~6am CT. Deliberately AFTER crew-score-recompute (0 9 * * *,
 * ~3-4am CT), because apply_crew_score_recompute is what writes
 * assignment_outcomes.was_late — the single most important input to a grade.
 * The SQL gate does not TRUST that ordering (it requires scored_at, so a row
 * simply waits for the next night if the recompute has not reached it), but
 * running after it is what keeps the normal case one-night rather than two.
 *
 * Retrospective, so it needs none of the same-day urgency the forecaster's own
 * 2am run has.
 */
export const frictionGrading = inngest.createFunction(
  { id: 'cron-friction-grading', name: 'Cron: Grade Friction Forecasts', retries: 2 },
  { cron: '0 11 * * *' },
  async ({ step, logger }) => {
    const { graded } = await step.run('apply-friction-grading', async () => {
      const supabase = createServiceClient({ system: 'inngest:friction-grading' })

      // One SQL function rather than a per-org fan-out: a pure DB join with no
      // external calls, so none of the reasoning that made pre-flight-friction
      // fan out per tenant (a forecast lookup each) applies. The whole grading
      // pass is one statement, claimed and written atomically.
      const { data, error } = await supabase.rpc('apply_friction_grading')
      if (error) throw new Error(`apply_friction_grading failed: ${error.message}`)
      return data as { graded: number }
    })

    logger.info(`[frictionGrading] graded ${graded} forecast row(s)`)
    return { graded }
  },
)
