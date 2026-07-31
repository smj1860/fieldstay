-- Pre-launch scalability audit: aggregate/filter RPCs that replace unbounded
-- platform-wide `.select()` scans in Inngest crons.
--
-- Context: PostgREST caps every response at max_rows (1000 — see
-- supabase/config.toml). An unbounded select returns the first 1000 rows with
-- no error and no truncation signal, so three cron paths were silently
-- producing wrong results at scale:
--
--   1. build-shopping-cart.ts fetched every inventory_items row for an org and
--      filtered `current_quantity < par_level` in JS. The Supabase JS client
--      has no column-to-column comparison (supabase.raw() does not exist), so
--      the comparison HAD to happen client-side — and a 50-property org with
--      115 catalog items has 5,750 rows, of which only the first 1,000 were
--      ever considered. inventory_below_par_items() does the comparison in SQL
--      so only genuinely below-par rows cross the wire.
--
--   2/3. metrics-snapshot.ts pulled whole tables (work_orders,
--      inventory_items ≈ 500k rows at 150 tenants, vendor_compliance_status)
--      every 30 minutes just to count them in JS — producing a gauge that
--      flat-lines at the row cap. The count functions below aggregate in the
--      database; zero rows cross the wire.
--
-- All three are SECURITY DEFINER with a pinned search_path and EXECUTE granted
-- only to service_role: they are called exclusively from Inngest steps that
-- already hold the service role key, and inventory_below_par_items() takes the
-- org_id explicitly so the caller cannot read across tenants by omission.

-- ── 1. Below-par inventory items for one org ────────────────────────────────

CREATE OR REPLACE FUNCTION public.inventory_below_par_items(
  p_org_id       uuid,
  p_property_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id                      uuid,
  name                    text,
  current_quantity        numeric,
  par_level               numeric,
  unit                    text,
  preferred_brand         text,
  property_id             uuid,
  first_count_recorded_at timestamptz,
  property_name           text,
  property_zip            text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT
    i.id,
    i.name,
    -- inventory_items.current_quantity is integer and par_level numeric; both
    -- are returned as numeric so the RETURNS TABLE shape is uniform (a type
    -- mismatch here is a hard runtime error, not a coercion).
    i.current_quantity::numeric,
    i.par_level::numeric,
    i.unit,
    i.preferred_brand,
    i.property_id,
    i.first_count_recorded_at,
    p.name AS property_name,
    p.zip  AS property_zip
  FROM inventory_items i
  JOIN properties p ON p.id = i.property_id
  WHERE i.org_id = p_org_id
    -- Items never actually counted default current_quantity to 0, which would
    -- otherwise look "below par" on every freshly-added item.
    AND i.first_count_recorded_at IS NOT NULL
    AND COALESCE(i.current_quantity, 0) < COALESCE(i.par_level, 1)
    AND (p_property_ids IS NULL OR i.property_id = ANY (p_property_ids))
  ORDER BY i.property_id, i.name;
$$;

COMMENT ON FUNCTION public.inventory_below_par_items(uuid, uuid[]) IS
  'Below-par inventory items for one org. Does the current_quantity < par_level comparison in SQL — the Supabase JS client cannot express a column-to-column comparison, so the previous JS-side filter required fetching every row and was silently capped at PostgREST max_rows.';

-- ── 2. Platform-wide open work-order backlog, grouped by status ─────────────

CREATE OR REPLACE FUNCTION public.metrics_work_order_backlog()
RETURNS TABLE (status text, count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT wo.status::text, COUNT(*)::bigint
  FROM work_orders wo
  WHERE wo.status IN ('pending', 'quote_requested', 'assigned', 'in_progress')
  GROUP BY wo.status;
$$;

COMMENT ON FUNCTION public.metrics_work_order_backlog() IS
  'Platform-wide open work-order counts by status for the metrics-snapshot cron. Aggregates in SQL so no rows cross the wire (and no PostgREST row cap applies).';

-- ── 3. Platform-wide below-par inventory count ─────────────────────────────

CREATE OR REPLACE FUNCTION public.metrics_inventory_below_par_count()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT COUNT(*)::bigint
  FROM inventory_items i
  WHERE i.first_count_recorded_at IS NOT NULL
    AND COALESCE(i.current_quantity, 0) < COALESCE(i.par_level, 1);
$$;

COMMENT ON FUNCTION public.metrics_inventory_below_par_count() IS
  'Platform-wide count of below-par inventory items for the metrics-snapshot cron. Replaces a whole-table select (~500k rows at 150 tenants) tallied in JS every 30 minutes.';

-- ── 4. Platform-wide vendor compliance status counts ───────────────────────

CREATE OR REPLACE FUNCTION public.metrics_vendor_compliance_counts()
RETURNS TABLE (compliance_status text, count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT v.compliance_status::text, COUNT(*)::bigint
  FROM vendor_compliance_status v
  WHERE v.compliance_status IS NOT NULL
  GROUP BY v.compliance_status;
$$;

COMMENT ON FUNCTION public.metrics_vendor_compliance_counts() IS
  'Platform-wide vendor compliance status counts for the metrics-snapshot cron. Aggregates in SQL instead of selecting the whole view and tallying in JS.';

-- ── Grants ─────────────────────────────────────────────────────────────────
-- Service role only: every caller is an Inngest step. Explicitly revoked from
-- PUBLIC/anon/authenticated so a SECURITY DEFINER function cannot be used as
-- a cross-tenant read primitive from a client session.

REVOKE ALL ON FUNCTION public.inventory_below_par_items(uuid, uuid[])   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.metrics_work_order_backlog()              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.metrics_inventory_below_par_count()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.metrics_vendor_compliance_counts()        FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.inventory_below_par_items(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_work_order_backlog()            TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_inventory_below_par_count()     TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_vendor_compliance_counts()      TO service_role;
