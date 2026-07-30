-- Org-scoped below-par inventory read for the PM dashboard.
--
-- The Ops Snapshot KPI fetched inventory_items with .limit(200) and NO
-- .order(), then did the current_quantity < par_level comparison in JS. That
-- makes the "below par" number on the main dashboard an arbitrary sample: a
-- 50-property org has thousands of items, PostgREST returns whichever 200 the
-- planner produced, and the KPI is meaningless. The Supabase JS client cannot
-- express a column-to-column comparison (supabase.raw() does not exist), so
-- the comparison has to happen in SQL.
--
-- 20260730400000 added inventory_below_par_items() for the Inngest side, but
-- that one is SECURITY DEFINER and granted to service_role only — deliberately,
-- since it takes an org_id and would otherwise be a cross-tenant read
-- primitive. This companion is SECURITY INVOKER, so RLS on inventory_items and
-- properties applies to the calling user exactly as it would for a direct
-- select: a spoofed p_org_id returns zero rows rather than another tenant's.
-- That is what makes it safe to grant to authenticated.
--
-- Predicate matches inventory_below_par_items() verbatim (strict <, and
-- first_count_recorded_at NOT NULL so never-counted items whose quantity
-- defaults to 0 don't all read as below par), so the dashboard KPI, the
-- notification bell, and the Kroger cart automation agree on one definition.

CREATE OR REPLACE FUNCTION public.inventory_below_par_for_org(p_org_id uuid)
RETURNS TABLE (
  id                      uuid,
  name                    text,
  property_id             uuid,
  current_quantity        numeric,
  par_level               numeric,
  first_count_recorded_at timestamptz
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT
    i.id,
    i.name,
    i.property_id,
    i.current_quantity::numeric,
    i.par_level::numeric,
    i.first_count_recorded_at
  FROM inventory_items i
  WHERE i.org_id = p_org_id
    AND i.is_active = true
    AND i.first_count_recorded_at IS NOT NULL
    AND COALESCE(i.current_quantity, 0) < COALESCE(i.par_level, 1)
  ORDER BY i.property_id, i.name;
$$;

COMMENT ON FUNCTION public.inventory_below_par_for_org(uuid) IS
  'Below-par inventory items for one org, RLS-enforced (SECURITY INVOKER) so it is safe for authenticated dashboard reads. Companion to the service-role inventory_below_par_items(); same predicate.';

REVOKE ALL ON FUNCTION public.inventory_below_par_for_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_below_par_for_org(uuid) TO authenticated, service_role;
