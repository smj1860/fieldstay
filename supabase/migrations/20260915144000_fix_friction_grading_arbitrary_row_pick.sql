-- ============================================================================
-- apply_friction_grading() picked an ARBITRARY assignment_outcomes row to
-- grade a whole turnover.
--
-- The original `candidates` CTE used `DISTINCT ON (pff.turnover_id) ... ORDER
-- BY pff.turnover_id, ao.id` on the theory that "every crew member's row for
-- a turnover carries identical was_late/completion_rate — any one row is
-- sufficient." That is false for was_missed/was_late: both are computed
-- PER-ASSIGNMENT in apply_crew_score_recompute(), not per-turnover. A
-- turnover with two crew where one no-showed and the other completed on time
-- produces two assignment_outcomes rows with genuinely different
-- was_missed/was_late values — and DISTINCT ON ... ORDER BY ao.id picks
-- whichever row has the numerically/lexically smaller gen_random_uuid() id,
-- which is RANDOM and uncorrelated with which crew member actually mattered.
-- A genuinely late/missed turnover could be graded 'none' (a permanent false
-- negative — graded_at is one-shot, never revisited) or a clean turnover
-- graded 'critical'. This directly inverts the grading loop's own stated
-- "recall first" design goal.
--
-- Fix: aggregate across EVERY relevant assignment_outcomes row for the
-- turnover instead of arbitrarily picking one, using worst-case (OR/MIN)
-- semantics — matching "recall first": if ANY assigned crew member was
-- missed or late, the turnover counts as missed/late; the turnover's
-- completion_rate is the WORST (lowest) of its crew rows, not an arbitrary
-- one.
--
-- This also closes a second, related gap: grading a turnover the moment ANY
-- ONE of its crew rows is scored — even while a sibling row is still
-- unscored — would silently drop that unscored sibling from the aggregate
-- and could grade the turnover 'none' before the crew member who was
-- actually late has even been scored yet. turnover_readiness below requires
-- EVERY relevant assignment_outcomes row for a turnover to have scored_at
-- set before that turnover becomes a grading candidate at all.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_friction_grading()
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
    -- never blocks — or corrupts — grading for its turnover.
    SELECT
      ao.turnover_id,
      ao.was_missed,
      ao.was_late,
      ao.completion_rate,
      ao.scored_at
    FROM assignment_outcomes ao
    WHERE ao.completed_at IS NOT NULL OR ao.was_missed = true
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
    WHERE pff.graded_at IS NULL
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
    WHERE pff.id = candidates.id
    RETURNING pff.id
  )
  SELECT count(*) FROM graded INTO v_graded_count;

  RETURN jsonb_build_object('graded', v_graded_count);
END;
$function$;
