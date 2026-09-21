-- ============================================================================
-- Close the assignment_outcomes loop: an AUTOMATED quality signal
--
-- Today a turnover with no PM rating contributes ZERO quality signal to
-- reliability_score — only lateness and missed-status move it. pm_rating is
-- 0/50 populated and no collection UI exists, so in practice the quality half
-- of the learning loop has never run at all.
--
-- This adds a signal that always computes, from data already captured and
-- already going unused: checklist_instance_items' is_completed,
-- requires_photo and photo_storage_path. It sits ALONGSIDE the pm_rating term
-- rather than replacing it — pm_rating stays exactly as it was: optional,
-- additive, zero when absent.
--
-- THE TURNOVER IS WHAT IS RATED, NOT THE CREW MEMBER. One computed pair per
-- turnover, applied identically to every crew member's row for it. An earlier
-- design filtered by completed_by_crew_id; that was wrong and is discarded —
-- do not reintroduce a per-crew filter on the completion/photo query.
-- ============================================================================

ALTER TABLE public.assignment_outcomes
  ADD COLUMN IF NOT EXISTS completion_rate numeric(4,3)
    CHECK (completion_rate BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS photo_compliance_rate numeric(4,3)
    CHECK (photo_compliance_rate BETWEEN 0 AND 1);

-- Both nullable with no default. NULL is the correct "not applicable" state,
-- not an oversight to backfill later: 0 would read as "totally failed" and 1
-- as "perfect" for something that never happened.
COMMENT ON COLUMN public.assignment_outcomes.completion_rate IS
  'Checklist items completed / total, for the TURNOVER (not the individual crew member) — every crew row for one turnover carries the same value. NULL means not applicable (no checklist items), never 0: 0 would read as "totally failed" for something that never happened. NULL contributes exactly 0 to the reliability delta.';

COMMENT ON COLUMN public.assignment_outcomes.photo_compliance_rate IS
  'Photo-required items with a photo / photo-required items completed, for the TURNOVER. NULL means no photo-required items were completed — not applicable, never 0 or 1. NULL contributes exactly 0 to the reliability delta.';

-- ── Fold the new signal into the delta ──────────────────────────────────────
--
-- Everything outside the two new COALESCE terms is byte-for-byte the live
-- function, including both rationale comments: the spec this came from
-- reproduced the body without them, and replacing the function would have
-- silently deleted the notes explaining why the claim step is atomic and why
-- capacity needs no claim at all.
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
  -- computed, claimed (scored_at set), and folded into a per-crew delta, all
  -- within a single UPDATE ... FROM chain. A retry after any failure here
  -- rolls back entirely (functions run in the caller's transaction) and sees
  -- the exact same unscored candidates again — no partial-apply/double-count
  -- window like the two-phase JS loop this replaces.
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
            -- dead code that only looks like a guard. Verified against the
            -- live database: under that shape a row with NULL ratios scored
            -- 0.04, identical to a perfect one, and a pm_rating-only row
            -- scored 0.10 where it had always scored 0.08 — which would have
            -- changed pm_rating's established behaviour as a side effect.
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
