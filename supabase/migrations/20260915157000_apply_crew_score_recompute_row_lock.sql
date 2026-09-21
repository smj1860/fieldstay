-- ============================================================================
-- apply_crew_score_recompute()'s claim step has no row-level lock, so two
-- concurrent invocations (an overlapping retry, a manual re-trigger racing
-- the scheduled run) can double-score the same assignment_outcomes rows.
--
-- The `candidates` CTE is a plain SELECT — no locking clause — that snapshots
-- every row where `scored_at IS NULL`. The function's own comment already
-- claims this is safe because "candidates are computed, claimed ... all
-- within a single UPDATE ... FROM chain" — but a plain CTE's snapshot is
-- taken once, and the `scored` UPDATE's join condition is just
-- `ao.id = candidates.id`, which never re-checks `scored_at IS NULL` against
-- the row's CURRENT state.
--
-- Two concurrent transactions, A and B, both running before either commits,
-- independently compute the SAME `candidates` set (neither has set
-- scored_at yet). Each then runs its own `scored` UPDATE against those ids.
-- Postgres genuinely locks each row as A's UPDATE applies it, so B's UPDATE
-- on the same rows BLOCKS — but once A commits and B is unblocked, B's
-- EvalPlanQual re-check only re-verifies `ao.id = candidates.id` against the
-- fresh row version, not `candidates`'s own WHERE clause (already
-- materialized before either UPDATE ran). B's join condition still holds
-- (the id didn't change), so B's UPDATE proceeds and re-scores the SAME rows
-- A already scored — applying the crew's reliability delta TWICE for one
-- turnover outcome, silently, with no error from either transaction.
--
-- Fix: `FOR UPDATE OF ao SKIP LOCKED` on the candidates read. This makes the
-- CLAIM itself — not just the eventual UPDATE — lock the underlying
-- assignment_outcomes rows as they are read. A's candidates scan locks its
-- rows immediately; B's concurrent candidates scan, running FOR UPDATE
-- against the same rows, SKIPS anything A already holds rather than
-- including it in B's own candidate set — so B's UPDATE never targets a row
-- A is mid-claim on, and the two invocations converge on disjoint work
-- instead of double-scoring. SKIP LOCKED rather than a blocking FOR UPDATE:
-- this is a background recompute, not a user-facing request where "wait for
-- the other one to finish" would be the right answer — an invocation that
-- finds everything already claimed should simply do nothing, not queue
-- behind another run of itself.
--
-- `OF ao` scopes the lock to assignment_outcomes only — the LEFT JOIN to
-- turnovers is read-only context for computing was_late and must not be
-- locked or excluded by SKIP LOCKED.
--
-- The capacity-score half below is unchanged: it is a pure recompute-from-
-- scratch every run, already idempotent by construction, and its own comment
-- already says "no claim step needed" — this fix is scoped to the one step
-- that actually claims rows.
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

  -- Capacity score: pure recompute-from-scratch every run (not a delta), so
  -- naturally idempotent/retry-safe on its own — no claim step needed.
  WITH capacity AS (
    SELECT
      crew_member_id,
      count(*) FILTER (WHERE property_bedrooms >= 4) AS large_count,
      count(*) AS total_count
    FROM assignment_outcomes
    WHERE property_bedrooms IS NOT NULL
      AND completed_at IS NOT NULL
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
