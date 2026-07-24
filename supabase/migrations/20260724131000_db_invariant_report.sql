-- db_invariant_report(): structural-enforcement Tier 3 backstop.
--
-- Returns a jsonb report of schema-level invariants that no code-side check
-- (ESLint, guardrail tests) can see. Called by scripts/check-db-invariants.mjs
-- from the CI db-invariants job against the E2E project — the checks needs
-- pg_catalog, which the REST API can't reach directly, so the query lives
-- here as a SECURITY DEFINER function callable only by service_role.
--
-- Sections:
--   tables_without_rls      — public tables with RLS disabled (must be empty)
--   tables_without_policies — RLS on but zero policies (deny-all; allowed
--                             only for the deliberately service-role-only
--                             tables allowlisted in the CI script)
--   unindexed_fk_columns    — FK columns with no covering index (leading
--                             prefix of a valid index). Partial indexes
--                             count: this codebase deliberately indexes
--                             nullable FKs as (col) WHERE col IS NOT NULL,
--                             and FK-enforcement probes are always col = $1,
--                             which implies that predicate.
--   anon_grant_tables       — tables with any anon grant (must be empty;
--                             see 20260724130000_revoke_stale_anon_table_grants.sql)

CREATE OR REPLACE FUNCTION public.db_invariant_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'tables_without_rls', (
      SELECT coalesce(jsonb_agg(t.tablename ORDER BY t.tablename), '[]'::jsonb)
      FROM pg_catalog.pg_tables t
      WHERE t.schemaname = 'public' AND NOT t.rowsecurity
    ),
    'tables_without_policies', (
      SELECT coalesce(jsonb_agg(t.tablename ORDER BY t.tablename), '[]'::jsonb)
      FROM pg_catalog.pg_tables t
      WHERE t.schemaname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = t.tablename
        )
    ),
    'unindexed_fk_columns', (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object('table', f.tbl, 'constraint', f.conname, 'columns', f.cols)
          ORDER BY f.tbl, f.conname
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT
          (SELECT cl.relname FROM pg_catalog.pg_class cl WHERE cl.oid = c.conrelid) AS tbl,
          c.conname,
          (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
           FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_catalog.pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
        FROM pg_catalog.pg_constraint c
        WHERE c.contype = 'f'
          AND c.connamespace = 'public'::regnamespace
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_index i
            WHERE i.indrelid = c.conrelid
              AND i.indisvalid
              AND (i.indkey::int2[])[0:cardinality(c.conkey)-1] @> c.conkey
          )
      ) f
    ),
    'anon_grant_tables', (
      SELECT coalesce(jsonb_agg(DISTINCT g.table_name::text ORDER BY g.table_name::text), '[]'::jsonb)
      FROM information_schema.role_table_grants g
      WHERE g.table_schema = 'public' AND g.grantee = 'anon'
    )
  );
$$;

-- Introspection-only, but there's no reason clients should ever call it.
REVOKE EXECUTE ON FUNCTION public.db_invariant_report() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.db_invariant_report() TO service_role;
