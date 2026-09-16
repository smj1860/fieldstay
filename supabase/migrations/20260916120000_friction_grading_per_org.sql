-- ============================================================================
-- Friction grading: per-org fan-out, not one platform-wide UPDATE...FROM.
--
-- apply_friction_grading() was the one exception to this codebase's
-- disciplined per-org fan-out convention (see unbounded-fanout-loops.test.ts)
-- for platform-wide Inngest work: a single unbatched UPDATE...FROM join
-- across the WHOLE pre_flight_friction + assignment_outcomes tables, inside
-- one step.run(), at platform scale. That statement holds row locks across
-- every tenant's pre_flight_friction rows for its duration, contending with
-- the two things that write that table live: a PM accepting/dismissing a
-- flagged turnover on the /ops exceptions panel, and the 2am
-- cron-pre-flight-friction upsert for whichever tenants it reaches while the
-- grading UPDATE is still running.
--
-- Fix: the cron side becomes a dispatcher (distinct org ids carrying an
-- ungraded row) that fans out one event per org — same shape as
-- billing-property-reconciliation.ts and pre-flight-friction.ts's own
-- dispatcher + per-org-handler pair — and this function is scoped to grade
-- exactly one tenant per call, so no single invocation ever locks more than
-- one org's rows and a slow/large org cannot block anyone else's grading.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_friction_grading(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_graded_count integer := 0;
BEGIN
  WITH relevant AS (
    -- A crew row counts toward grading once its outcome is KNOWN: it either
    -- completed (successfully or not) or was missed outright. An assignment
    -- still open (neither completed nor missed) never enters this set, so it
    -- never blocks — or corrupts — grading for its turnover. Scoped to the
    -- one org this call is grading, the actual fix for the finding above:
    -- the original version scanned every tenant's assignment_outcomes here.
    SELECT
      ao.turnover_id,
      ao.was_missed,
      ao.was_late,
      ao.completion_rate,
      ao.scored_at
    FROM assignment_outcomes ao
    WHERE ao.org_id = p_org_id
      AND (ao.completed_at IS NOT NULL OR ao.was_missed = true)
  ),
  turnover_readiness AS (
    -- Per turnover: how many relevant crew rows exist vs. how many are
    -- scored. Only a turnover where EVERY relevant row is scored is ready —
    -- an unscored sibling (was_late is written only by
    -- apply_crew_score_recompute's claim step, so a just-completed
    -- assignment's row can sit with scored_at NULL for a while) must hold up
    -- grading for the whole turnover, not just get silently excluded from
    -- the aggregate while a stale sibling's data is used instead.
    SELECT
      turnover_id,
      count(*)                                          AS relevant_rows,
      count(*) FILTER (WHERE scored_at IS NOT NULL)      AS scored_rows
    FROM relevant
    GROUP BY turnover_id
  ),
  candidates AS (
    SELECT
      pff.id,
      bool_or(r.was_missed)  AS was_missed,
      bool_or(r.was_late)    AS was_late,
      min(r.completion_rate) AS completion_rate
    FROM pre_flight_friction pff
    JOIN relevant r             ON r.turnover_id = pff.turnover_id
    JOIN turnover_readiness tr  ON tr.turnover_id = pff.turnover_id
    WHERE pff.org_id = p_org_id
      AND pff.graded_at IS NULL
      AND tr.relevant_rows = tr.scored_rows
    GROUP BY pff.id
  ),
  graded AS (
    UPDATE pre_flight_friction pff
    SET
      actual_severity = CASE
        WHEN candidates.was_missed THEN 'critical'
        -- Placeholder threshold — meaningfully incomplete, not "any
        -- imperfection". Tune once there is real graded volume.
        WHEN candidates.was_late OR COALESCE(candidates.completion_rate, 1) < 0.85 THEN 'high'
        ELSE 'none'
      END,
      actual_was_late        = candidates.was_late,
      actual_completion_rate = candidates.completion_rate,
      graded_at              = now()
    FROM candidates
    -- The org filter here is redundant with candidates' own org scope (every
    -- id in it already came from a pff row filtered to p_org_id) but kept
    -- explicit: every write in this codebase names its tenant scope rather
    -- than relying transitively on a join upstream having done it.
    WHERE pff.id = candidates.id
      AND pff.org_id = p_org_id
    RETURNING pff.id
  )
  SELECT count(*) FROM graded INTO v_graded_count;

  RETURN jsonb_build_object('graded', v_graded_count);
END;
$function$;

-- The old no-arg entry point is retired, not overloaded alongside the new
-- one: the Inngest side always grades exactly one org per call now, so there
-- is no remaining caller for a platform-wide signature to serve, and leaving
-- it in place would be a second, unscoped way to run the same UPDATE...FROM
-- this migration exists to get rid of.
DROP FUNCTION IF EXISTS public.apply_friction_grading();

-- Covers the dispatcher's own scan: distinct org ids with at least one
-- ungraded row. pre_flight_friction_ungraded_idx (20260913111019) indexes
-- turnover_id only under the same WHERE graded_at IS NULL predicate, so it is
-- not a covering index for a query that only ever needs org_id — this is a
-- companion, not a replacement.
CREATE INDEX IF NOT EXISTS pre_flight_friction_ungraded_org_idx
  ON public.pre_flight_friction (org_id)
  WHERE graded_at IS NULL;
