import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { fetchDistinctOrgIds }  from '@/lib/inngest/paginate'

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
 *
 * DISPATCHER + PER-ORG HANDLER, not a single platform-wide call. Grading used
 * to be one unbatched apply_friction_grading() UPDATE...FROM spanning every
 * tenant's pre_flight_friction rows in one step.run() — the one exception to
 * this codebase's per-org fan-out convention for platform-wide Inngest work,
 * and it held row locks across the whole table for however long that join
 * took, contending with a PM accepting/dismissing a flagged turnover on the
 * /ops exceptions panel and with the 2am pre-flight-friction cron's own
 * upsert. Same shape as billing-property-reconciliation.ts and
 * pre-flight-friction.ts's own dispatcher + per-org-handler pair: find the
 * orgs with work, fan out one event each, and scope the SQL function itself
 * to a single tenant per call (20260916120000_friction_grading_per_org.sql).
 */
export const frictionGrading = inngest.createFunction(
  { id: 'cron-friction-grading', name: 'Cron: Grade Friction Forecasts', retries: 2 },
  { cron: '0 11 * * *' },
  async ({ step, logger }) => {
    const orgIds = await step.run('find-orgs-with-ungraded-rows', async () => {
      const supabase = createServiceClient({ system: 'inngest:friction-grading' })
      return fetchDistinctOrgIds(
        (from, to) => supabase
          .from('pre_flight_friction')
          .select('org_id')
          .is('graded_at', null)
          .order('org_id', { ascending: true })
          .range(from, to),
        { label: 'friction-grading.orgs' },
      )
    })

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-friction-grading',
        orgIds.map((orgId) => ({
          name: 'friction/grading.requested' as const,
          data: { org_id: orgId },
        })),
      )
    }

    logger.info(`[frictionGrading] dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  },
)

export const gradeFrictionForOrg = inngest.createFunction(
  {
    id:      'friction-grading-for-org',
    name:    'Friction Grading: Grade One Org',
    retries: 2,
    // Per-org key, mirroring reconcilePropertyCountForOrg: a retried
    // dispatcher step.sendEvent() can re-queue a second event for the same
    // org, and two concurrent invocations grading the same org would just be
    // wasted work (apply_friction_grading is naturally idempotent — a row
    // already graded no longer matches `graded_at IS NULL`), but the global
    // cap is what keeps the daily burst from opening far more concurrent
    // connections than one grading pass needs.
    concurrency: [{ limit: 10 }, { limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'friction/grading.requested' },
  async ({ event, step, logger }) => {
    const orgId = event.data.org_id

    const { graded } = await step.run('apply-friction-grading', async () => {
      const supabase = createServiceClient({ system: 'inngest:friction-grading' })
      const { data, error } = await supabase.rpc('apply_friction_grading', { p_org_id: orgId })
      if (error) throw new Error(`apply_friction_grading failed for org ${orgId}: ${error.message}`)
      return data as { graded: number }
    })

    logger.info(`[frictionGrading] org=${orgId}: graded ${graded} forecast row(s)`)
    return { org_id: orgId, graded }
  },
)
