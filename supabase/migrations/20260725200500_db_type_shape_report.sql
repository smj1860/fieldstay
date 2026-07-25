-- db_type_shape_report(): structural-enforcement Tier 3, check 4 — the
-- types/database.ts drift gate's DB-side half.
--
-- Returns a jsonb snapshot of the public schema's shape so
-- scripts/check-type-drift.mjs (CI db-invariants job) can diff it against the
-- committed types/database.ts. CI only holds the E2E project's service-role
-- key — no Supabase management token — so schema introspection has to go
-- through a service-role-only RPC like db_invariant_report(), not the
-- Supabase CLI type generator.
--
-- Why this exists: the E2E project's wo_status enum silently lacked
-- 'quote_requested' (present in production, never captured in a migration),
-- which made every /maintenance board query fail invisibly there and cost
-- significant debugging time — see
-- 20260725043000_add_quote_requested_to_wo_status.sql. This report makes
-- schema-vs-types drift a CI failure instead of a mystery.
--
-- Shape:
--   tables — { table_name: { column_name: { data_type, udt_name, is_nullable } } }
--             BASE TABLEs in public only (views excluded — types/database.ts
--             models views separately under Database.public.Views)
--   enums  — { enum_name: [labels in enumsortorder] } for public enum types

CREATE OR REPLACE FUNCTION public.db_type_shape_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'tables', (
      SELECT coalesce(jsonb_object_agg(x.table_name, x.cols), '{}'::jsonb)
      FROM (
        SELECT c.table_name,
               jsonb_object_agg(c.column_name, jsonb_build_object(
                 'data_type',   c.data_type,
                 'udt_name',    c.udt_name,
                 'is_nullable', (c.is_nullable = 'YES')
               )) AS cols
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND EXISTS (
            SELECT 1 FROM information_schema.tables t
            WHERE t.table_schema = 'public'
              AND t.table_name   = c.table_name
              AND t.table_type   = 'BASE TABLE'
          )
        GROUP BY c.table_name
      ) x
    ),
    'enums', (
      SELECT coalesce(jsonb_object_agg(e.enum_name, e.labels), '{}'::jsonb)
      FROM (
        SELECT t.typname AS enum_name,
               jsonb_agg(en.enumlabel ORDER BY en.enumsortorder) AS labels
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_enum en ON en.enumtypid = t.oid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        GROUP BY t.typname
      ) e
    )
  );
$$;

-- Introspection-only, but there's no reason clients should ever call it.
REVOKE EXECUTE ON FUNCTION public.db_type_shape_report() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.db_type_shape_report() TO service_role;
