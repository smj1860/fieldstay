-- ============================================================================
-- Friction Forecaster — the grading feedback loop
--
-- Every turnover already gets a pre_flight_friction row each morning, not just
-- the flagged ones (buildFrictionRow runs the full array; severity 'none' rows
-- are upserted as 'resolved', never skipped). This grades those rows against
-- what actually happened, so the forecaster can be measured instead of
-- believed.
--
-- GRADE EVERY ROW, NEVER FILTERED BY PREDICTED SEVERITY. A turnover scored
-- 'none' that turned out late is a FALSE NEGATIVE — the forecaster gave false
-- confidence, which matters more than a false positive that merely annoyed a
-- PM with an unnecessary flag. The calibration view leads with RECALL for that
-- reason; get it backwards and the report looks healthy while the forecaster
-- silently misses the cases that matter most.
--
-- This produces EVIDENCE, not decisions: no weight in lib/scoring/friction.ts
-- is auto-adjusted from it.
-- ============================================================================

ALTER TABLE public.pre_flight_friction
  ADD COLUMN IF NOT EXISTS actual_severity text
    CHECK (actual_severity IN ('none', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS actual_was_late boolean,
  ADD COLUMN IF NOT EXISTS actual_completion_rate numeric(4,3)
    CHECK (actual_completion_rate BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS graded_at timestamptz;

COMMENT ON COLUMN public.pre_flight_friction.graded_at IS
  'One-shot, like assignment_outcomes.scored_at. A turnover''s actual outcome does not change after it happens, so a graded row is never re-graded. NULL means not yet gradable — the outcome data is missing or incomplete, and a later run picks it up.';

-- The grading scan's own predicate. Partial, because the set it walks is
-- exactly the ungraded tail and shrinks to near-nothing in steady state.
CREATE INDEX IF NOT EXISTS pre_flight_friction_ungraded_idx
  ON public.pre_flight_friction (turnover_id)
  WHERE graded_at IS NULL;

-- ── Grading ─────────────────────────────────────────────────────────────────
--
-- One SQL function rather than a per-org Inngest fan-out: this is a pure DB
-- join with no external API calls, so none of the reasoning that justified
-- fan-out in pre-flight-friction.ts (slow per-org forecast lookups) applies.
CREATE OR REPLACE FUNCTION public.apply_friction_grading()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_graded_count integer := 0;
BEGIN
  WITH candidates AS (
    -- DISTINCT ON turnover_id: per the "rate the turnover, not the person"
    -- design, every crew member's row for a turnover carries identical
    -- was_late/completion_rate — any one row is sufficient, no aggregation.
    SELECT DISTINCT ON (pff.turnover_id)
      pff.id,
      ao.was_missed,
      ao.was_late,
      ao.completion_rate
    FROM pre_flight_friction pff
    JOIN assignment_outcomes ao ON ao.turnover_id = pff.turnover_id
    WHERE pff.graded_at IS NULL
      AND (ao.completed_at IS NOT NULL OR ao.was_missed = true)
      -- scored_at, not just completed_at. was_late is written ONLY by
      -- apply_crew_score_recompute's claim step, so a turnover is COMPLETE
      -- with was_late still NULL from the moment it finishes until that cron
      -- next runs. Grading inside that window sends NULL through the CASE
      -- below, where `NULL OR <false>` is NULL rather than true, so the ELSE
      -- claims it and a possibly-late turnover is recorded as 'none' — then
      -- never revisited, because graded_at is one-shot. That is a permanent
      -- false negative in exactly the metric this loop exists to measure.
      -- An unscored row is "no outcome data yet"; it waits for a later run.
      AND ao.scored_at IS NOT NULL
    ORDER BY pff.turnover_id, ao.id
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

-- ── Calibration ─────────────────────────────────────────────────────────────
--
-- All-time and platform-wide. A time-scoped version is a filter on top of this
-- (WHERE graded_at IS NOT NULL AND turnover_date >= now() - interval '30 days'),
-- not something to bake in before there is volume to window.
CREATE OR REPLACE VIEW public.friction_forecast_calibration AS
WITH graded AS (
  SELECT * FROM pre_flight_friction WHERE graded_at IS NOT NULL
),
actual_friction AS (
  SELECT * FROM graded WHERE actual_severity IN ('high', 'critical')
),
predicted_flagged AS (
  SELECT * FROM graded WHERE severity IN ('high', 'critical')
)
SELECT
  (SELECT count(*) FROM graded)          AS total_graded,
  (SELECT count(*) FROM actual_friction) AS actual_friction_count,
  -- RECALL FIRST — of turnovers that actually had friction, what fraction did
  -- the forecaster catch. This is the number that matters.
  ROUND(
    (SELECT count(*) FROM actual_friction WHERE severity IN ('high','critical'))::numeric
    / NULLIF((SELECT count(*) FROM actual_friction), 0),
    3
  ) AS recall,
  -- Precision — secondary. Of turnovers flagged, what fraction were real.
  ROUND(
    (SELECT count(*) FROM predicted_flagged WHERE actual_severity IN ('high','critical'))::numeric
    / NULLIF((SELECT count(*) FROM predicted_flagged), 0),
    3
  ) AS precision,
  (SELECT count(*) FROM graded WHERE severity = 'none' AND actual_severity IN ('high','critical')) AS false_negatives,
  (SELECT count(*) FROM graded WHERE severity IN ('high','critical') AND actual_severity = 'none') AS false_positives;

COMMENT ON VIEW public.friction_forecast_calibration IS
  'Platform-wide, all-time forecaster calibration. RECALL FIRST: of turnovers that actually had friction, what fraction did the forecaster catch. A false negative gave a PM false confidence, which matters more than a false positive that merely annoyed them. Deliberately NOT org-scoped and NOT granted to anon/authenticated — it aggregates every tenant and is a service-role/staff read only.';

-- Explicit, even though Supabase's default privileges already grant a new view
-- only to postgres/service_role (verified before writing this). The REVOKE is
-- what keeps that true if a later blanket grant migration widens the schema:
-- this view crosses every tenant boundary by design, so it must never become
-- readable by a signed-in user.
REVOKE ALL ON public.friction_forecast_calibration FROM anon, authenticated;
