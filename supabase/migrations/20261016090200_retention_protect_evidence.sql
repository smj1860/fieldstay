-- Extends retention_protected_table_violations() (20260822090115_inspections_phase1)
-- to the Stay Evidence Ledger tables. The ledger is append-only and the claim
-- packets cite it; a retention sweep that removed rows would silently break the
-- chain of custody. lib/retention/registry.ts carries the TypeScript half.
--
-- Catalog-only, no DML. The function must always return zero rows.
CREATE OR REPLACE FUNCTION public.retention_protected_table_violations()
RETURNS TABLE (function_name text, protected_table text)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $fn$
  SELECT p.proname::text, t.tbl
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (VALUES
    ('inspections'), ('inspection_items'), ('inspection_forms'),
    ('inspection_form_sections'), ('inspection_form_items'),
    ('evidence_events'), ('evidence_stay_brackets'), ('property_evidence_spots')
  ) AS t(tbl)
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND pg_catalog.pg_get_functiondef(p.oid) ~* ('delete\s+from\s+(public\.)?' || t.tbl || '\M')
$fn$;

REVOKE ALL     ON FUNCTION public.retention_protected_table_violations() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.retention_protected_table_violations() TO service_role;

COMMENT ON FUNCTION public.retention_protected_table_violations() IS
  'Catalog-only. Any public function whose body DELETEs from an inspections or evidence-ledger table. Must always be empty: both are evidence and are excluded from every retention sweep.';
