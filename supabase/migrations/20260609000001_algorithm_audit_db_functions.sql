-- Algorithm audit remediation — DB-side aggregation functions
-- CRIT-1A: push repeat-issue detection to DB to avoid PostgREST 1000-row silent truncation
-- CRIT-1B: push asset repair history aggregation to DB for same reason

-- ── CRIT-1A: Repeat work order detection ─────────────────────────────────────────
-- Returns (org_id, property_id, category, wo_count) for combos with >= 3 WOs
-- since the provided cutoff date (excluding cancelled WOs).
CREATE OR REPLACE FUNCTION get_repeat_issues(since_date timestamptz)
RETURNS TABLE(org_id uuid, property_id uuid, category text, wo_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    wo.org_id,
    wo.property_id,
    wo.category,
    COUNT(*) AS wo_count
  FROM work_orders wo
  WHERE wo.status != 'cancelled'
    AND wo.created_at >= since_date
  GROUP BY wo.org_id, wo.property_id, wo.category
  HAVING COUNT(*) >= 3
$$;

REVOKE EXECUTE ON FUNCTION get_repeat_issues(timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_repeat_issues(timestamptz) TO authenticated;
GRANT  EXECUTE ON FUNCTION get_repeat_issues(timestamptz) TO service_role;

-- ── CRIT-1B: Asset repair history aggregation ─────────────────────────────────────
-- Returns one row per asset with aggregate repair stats from completed WOs.
CREATE OR REPLACE FUNCTION get_asset_repair_summary()
RETURNS TABLE(
  asset_id          uuid,
  total_repairs     bigint,
  total_repair_cost numeric,
  last_serviced_at  date
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    wo.asset_id,
    COUNT(*) AS total_repairs,
    COALESCE(SUM(wo.actual_cost), SUM(wo.estimated_cost), 0)::numeric AS total_repair_cost,
    MAX(wo.completed_date)::date AS last_serviced_at
  FROM work_orders wo
  WHERE wo.asset_id IS NOT NULL
    AND wo.status = 'completed'
  GROUP BY wo.asset_id
$$;

REVOKE EXECUTE ON FUNCTION get_asset_repair_summary() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_asset_repair_summary() TO authenticated;
GRANT  EXECUTE ON FUNCTION get_asset_repair_summary() TO service_role;
