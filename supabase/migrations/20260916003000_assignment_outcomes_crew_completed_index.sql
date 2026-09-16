-- ============================================================================
-- [HIGH] Supporting index for apply_crew_score_recompute()'s capacity-score
-- CTE (see 20260916002000_crew_score_recompute_capacity_window.sql), which
-- filters on `property_bedrooms IS NOT NULL AND completed_at IS NOT NULL AND
-- completed_at >= now() - interval '180 days'` and groups by
-- crew_member_id. A partial index on (crew_member_id, completed_at) WHERE
-- property_bedrooms IS NOT NULL matches that filter/group shape directly —
-- the leading crew_member_id column serves the GROUP BY, completed_at
-- serves the rolling-window bound, and the partial WHERE keeps the index
-- from carrying every assignment_outcomes row that never had
-- property_bedrooms populated at all.
--
-- Own migration file: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, and this repo's convention (established by
-- 20260916001000_checklist_instance_items_completed_index.sql, the only
-- other real use of CONCURRENTLY in this migration history) is one
-- CONCURRENTLY statement per file.
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignment_outcomes_crew_completed
  ON public.assignment_outcomes (crew_member_id, completed_at)
  WHERE property_bedrooms IS NOT NULL;
