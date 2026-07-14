-- Fix two real bugs found in an audit of this session's diff:
--
-- 1. HIGH — cron/crew-score-recompute.ts's apply-score-deltas step applied
--    reliability deltas to crew_members and marked assignment_outcomes.scored_at
--    in two separate sequential loops with no transaction. A failure between
--    the two loops (transient DB error mid-loop) left reliability_score
--    already updated with the full delta while some outcomes stayed
--    unmarked; a retry then recomputed a partial delta for the still-unmarked
--    rows and added it on top of the already-applied full delta —
--    double-counting. Moving the whole read+delta+write into one SQL
--    function makes it atomic: it runs in the caller's transaction, so any
--    failure rolls back the entire thing and a retry sees the exact same
--    unscored candidates again.
--
-- 2. MEDIUM (x4) — both crons issued one UPDATE per row inside a JS loop
--    instead of a single batched statement (crew reliability_score,
--    assignment_outcomes.scored_at/was_late, crew capacity_score, vendor
--    avg_rating/rating_count/on_time_pct/on_time_sample_size). A plain
--    Supabase .upsert() with a minimal per-row payload isn't a safe
--    alternative here — both crew_members and vendors have NOT NULL columns
--    (name, org_id, role, stripe_connect_token, ...) with no defaults, so an
--    upsert's theoretical INSERT path fails on those columns even though
--    only an UPDATE was intended. A SQL function using UPDATE ... FROM
--    (aggregate CTE) avoids this — it's a pure UPDATE, no INSERT branch.
--
-- apply_crew_score_recompute() replaces the two-loop apply-score-deltas step
-- AND the capacity-score step from cron/crew-score-recompute.ts.
-- recompute_vendor_scores() replaces the per-vendor loop in
-- cron/vendor-score-recompute.ts.
CREATE OR REPLACE FUNCTION public.apply_crew_score_recompute()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      ao.pm_rating
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
    RETURNING ao.id, candidates.crew_member_id, candidates.was_missed, candidates.was_late, candidates.pm_rating
  ),
  deltas AS (
    SELECT
      crew_member_id,
      SUM(
        CASE
          WHEN was_missed THEN -0.15
          ELSE
            (CASE WHEN was_late THEN -0.05 ELSE 0.02 END)
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
$$;

REVOKE EXECUTE ON FUNCTION public.apply_crew_score_recompute() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_crew_score_recompute() TO service_role;

CREATE OR REPLACE FUNCTION public.recompute_vendor_scores()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  WITH wo_stats AS (
    SELECT
      wo.vendor_id,
      count(*) FILTER (WHERE wo.vendor_rating IS NOT NULL AND wo.vendor_rating > 0) AS rating_count,
      avg(wo.vendor_rating) FILTER (WHERE wo.vendor_rating IS NOT NULL AND wo.vendor_rating > 0) AS avg_rating_raw,
      count(*) FILTER (WHERE wo.status = 'completed' AND wo.scheduled_date IS NOT NULL AND wo.completed_date IS NOT NULL) AS on_time_sample_size,
      count(*) FILTER (WHERE wo.status = 'completed' AND wo.scheduled_date IS NOT NULL AND wo.completed_date IS NOT NULL AND wo.completed_date <= wo.scheduled_date) AS on_time_count
    FROM work_orders wo
    WHERE wo.vendor_id IS NOT NULL
    GROUP BY wo.vendor_id
  ),
  updated AS (
    UPDATE vendors v
    SET
      avg_rating          = CASE WHEN s.rating_count > 0 THEN ROUND(s.avg_rating_raw, 1) ELSE NULL END,
      rating_count        = COALESCE(s.rating_count, 0),
      on_time_pct          = CASE WHEN s.on_time_sample_size >= 3 THEN ROUND((s.on_time_count::numeric / s.on_time_sample_size) * 100) ELSE NULL END,
      on_time_sample_size  = COALESCE(s.on_time_sample_size, 0),
      updated_at           = now()
    FROM wo_stats s
    WHERE v.id = s.vendor_id
    RETURNING v.id
  )
  SELECT count(*) FROM updated INTO v_updated;

  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recompute_vendor_scores() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_vendor_scores() TO service_role;
