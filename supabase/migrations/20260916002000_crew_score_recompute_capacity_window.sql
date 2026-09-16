-- ============================================================================
-- [HIGH] apply_crew_score_recompute()'s capacity-score branch is an
-- unwindowed full-table aggregate.
--
-- Per its own comment (20260915157000_apply_crew_score_recompute_row_lock.sql),
-- the capacity half is "a pure recompute-from-scratch every run" over
-- `assignment_outcomes WHERE property_bedrooms IS NOT NULL AND completed_at
-- IS NOT NULL`, GROUP BY crew_member_id — no time bound at all. Every crew
-- member's ENTIRE lifetime of completed assignments is re-aggregated on
-- every run of this cron, forever. At 10M assignment_outcomes rows this is a
-- full scan + full GROUP BY every time it runs, and unlike the reliability
-- half above it (a bounded claim-and-score over rows with `scored_at IS
-- NULL`), nothing here shrinks as the table grows — the cost is
-- monotonically increasing with platform age.
--
-- This is also a real behavioral drift from this codebase's own established
-- convention: crew_speed_baselines (lib/inngest/functions/auto-assign-
-- turnover.ts) rolls a 90-day FAMILIARITY_WINDOW_DAYS window specifically
-- "never a lifetime average" (CLAUDE.md), and the sibling Bayesian
-- checklist-signal cron (lib/inngest/functions/cron/checklist-signals.ts)
-- rolls a 180-day OBSERVATION_WINDOW_DAYS window for exactly this reason —
-- its own comment: "with cumulative counts old observations are never
-- actually down-weighted, they accumulate forever: [a stale signal] would
-- keep [applying] ... and the unbounded fetch grows with platform age x
-- volume." The capacity-score CTE was the one place in the crew-scoring
-- family that never got that treatment.
--
-- FIX: bound the capacity CTE to a rolling 180-day window, matching
-- OBSERVATION_WINDOW_DAYS (the more directly analogous sibling cron — both
-- are "recompute a rate from a bounded recent sample," unlike
-- crew_speed_baselines' 90-day duration-focused window). A crew member's
-- room-size mix from a year ago should not keep dictating what they get
-- assigned today; a rolling window lets a crew member's demonstrated recent
-- capacity to handle large properties actually move the score, the same way
-- their reliability score already responds to recent outcomes rather than
-- lifetime ones.
--
-- Everything else in this function — the `scored`/`deltas`/`updated_crew`
-- CTEs, the FOR UPDATE OF ao SKIP LOCKED claim, and critically the NULL-
-- handling CASE order in the reliability delta (NULL branch FIRST, per
-- CLAUDE.md's assignment_outcomes section and enforced by
-- unit/guardrails/null-is-not-a-score.test.ts) — is reproduced byte-for-byte
-- from 20260915157000_apply_crew_score_recompute_row_lock.sql. The ONLY
-- change in this CREATE OR REPLACE is the added `completed_at >=` bound in
-- the capacity CTE's WHERE clause.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_crew_score_recompute()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_scored_count   integer := 0;
  v_crew_count     integer := 0;
  v_capacity_count integer := 0;
BEGIN
  -- Atomically claim + score outcomes in one statement: candidates are
  -- locked (FOR UPDATE OF ao SKIP LOCKED), claimed (scored_at set), and
  -- folded into a per-crew delta, all within a single UPDATE ... FROM chain.
  -- A retry after any failure here rolls back entirely (functions run in the
  -- caller's transaction) and sees the exact same unscored candidates again
  -- — no partial-apply/double-count window like the two-phase JS loop this
  -- replaces, and no double-claim window against a CONCURRENT invocation
  -- either, now that the candidate rows are locked at read time.
  WITH candidates AS (
    SELECT
      ao.id,
      ao.crew_member_id,
      ao.was_missed,
      (
        NOT ao.was_missed
        AND ao.completed_at IS NOT NULL
        AND t.checkin_datetime IS NOT NULL
        AND ao.completed_at > t.checkin_datetime
      ) AS was_late,
      ao.pm_rating,
      ao.completion_rate,
      ao.photo_compliance_rate
    FROM assignment_outcomes ao
    LEFT JOIN turnovers t ON t.id = ao.turnover_id
    WHERE ao.scored_at IS NULL
      AND (ao.completed_at IS NOT NULL OR ao.was_missed = true)
    FOR UPDATE OF ao SKIP LOCKED
  ),
  scored AS (
    UPDATE assignment_outcomes ao
    SET scored_at = now(),
        was_late  = candidates.was_late
    FROM candidates
    WHERE ao.id = candidates.id
    RETURNING ao.id, candidates.crew_member_id, candidates.was_missed, candidates.was_late,
              candidates.pm_rating, candidates.completion_rate, candidates.photo_compliance_rate
  ),
  deltas AS (
    SELECT
      crew_member_id,
      SUM(
        CASE
          WHEN was_missed THEN -0.15
          ELSE
            (CASE WHEN was_late THEN -0.05 ELSE 0.02 END)
            -- Automated quality signal — ALWAYS evaluated, unlike pm_rating
            -- below. A NULL ratio (no checklist items, or no completed
            -- photo-required items) contributes exactly 0: never a fabricated
            -- penalty or bonus for data that does not apply.
            --
            -- The NULL guard is the FIRST branch, and it has to be. Wrapping
            -- this in COALESCE(CASE WHEN rate < 1.0 ... ELSE 0.01 END, 0) —
            -- the obvious shape — silently does the opposite: `NULL < 1.0` is
            -- NULL, not false, so the WHEN does not match and the ELSE claims
            -- it, handing "not applicable" the same +0.01 bonus a flawless
            -- turnover gets. The CASE never yields NULL, so the COALESCE is
            -- dead code that only looks like a guard.
            + CASE
                WHEN completion_rate IS NULL THEN 0
                WHEN completion_rate < 1.0   THEN -0.05 * (1 - completion_rate)
                ELSE 0.01
              END
            + CASE
                WHEN photo_compliance_rate IS NULL THEN 0
                WHEN photo_compliance_rate < 1.0   THEN -0.03 * (1 - photo_compliance_rate)
                ELSE 0.01
              END
            -- Unchanged — optional, additive, exactly as it already was.
            + COALESCE((pm_rating - 3) * 0.03, 0)
        END
      ) AS delta
    FROM scored
    GROUP BY crew_member_id
  ),
  updated_crew AS (
    UPDATE crew_members cm
    SET reliability_score = GREATEST(0, LEAST(1, COALESCE(cm.reliability_score, 1.0) + deltas.delta)),
        updated_at = now()
    FROM deltas
    WHERE cm.id = deltas.crew_member_id
    RETURNING cm.id
  )
  SELECT
    (SELECT count(*) FROM scored),
    (SELECT count(*) FROM updated_crew)
  INTO v_scored_count, v_crew_count;

  -- Capacity score: pure recompute-from-scratch EVERY RUN, over a rolling
  -- 180-day window (matches OBSERVATION_WINDOW_DAYS in
  -- lib/inngest/functions/cron/checklist-signals.ts) rather than the crew
  -- member's entire lifetime — see header comment. Still no claim step
  -- needed: it's a recompute, not a claim-and-delta, so it's naturally
  -- idempotent/retry-safe on its own.
  WITH capacity AS (
    SELECT
      crew_member_id,
      count(*) FILTER (WHERE property_bedrooms >= 4) AS large_count,
      count(*) AS total_count
    FROM assignment_outcomes
    WHERE property_bedrooms IS NOT NULL
      AND completed_at IS NOT NULL
      AND completed_at >= now() - interval '180 days'
    GROUP BY crew_member_id
    HAVING count(*) >= 3
  ),
  updated_capacity AS (
    UPDATE crew_members cm
    SET capacity_score = ROUND((capacity.large_count::numeric / capacity.total_count), 3),
        updated_at = now()
    FROM capacity
    WHERE cm.id = capacity.crew_member_id
    RETURNING cm.id
  )
  SELECT count(*) FROM updated_capacity INTO v_capacity_count;

  RETURN jsonb_build_object(
    'scored',          v_scored_count,
    'crewUpdated',     v_crew_count,
    'capacityUpdated', v_capacity_count
  );
END;
$function$;

COMMENT ON FUNCTION public.apply_crew_score_recompute() IS
  'Recomputes crew reliability_score (claim-and-delta over unscored '
  'assignment_outcomes, FOR UPDATE OF ao SKIP LOCKED) and capacity_score '
  '(pure recompute over a rolling 180-day window of completed outcomes with '
  'property_bedrooms set — bounded in '
  '20260916002000_crew_score_recompute_capacity_window.sql; previously an '
  'unwindowed full-table aggregate that grew with the table forever). The '
  'reliability delta''s NULL-handling CASE branches (completion_rate, '
  'photo_compliance_rate) MUST test IS NULL first — see CLAUDE.md''s '
  'assignment_outcomes section and unit/guardrails/null-is-not-a-score.test.ts.';
