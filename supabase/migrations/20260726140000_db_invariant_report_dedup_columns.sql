-- db_invariant_report(): add a 5th section, dedup_columns_without_unique_index.
--
-- CLAUDE.md documents two naming conventions for dedup/idempotency-key
-- columns: `dedupe_key`/`dedup_key` (notifications, communication_logs,
-- reservation_messages) and `source_reference_id` (owner_transactions,
-- paired with `source`). Every current instance of both conventions
-- happens to carry a real UNIQUE or partial-unique index today — but
-- nothing has ever verified that at the DB level; a future column named
-- to look like a dedup key could be added with no actual uniqueness
-- backing it, and nothing would catch it. This closes that gap.
--
-- A column counts as covered if it appears anywhere in the key list of
-- any valid unique index on its table (full or partial — partial unique
-- indexes, e.g. `... WHERE dedupe_key IS NOT NULL`, still list the column
-- in pg_index.indkey regardless of the predicate, same as
-- unindexed_fk_columns' existing partial-index handling below).

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
    ),
    'dedup_columns_without_unique_index', (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object('table', d.tbl, 'column', d.col)
          ORDER BY d.tbl, d.col
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT cl.relname AS tbl, a.attname AS col, a.attrelid AS relid, a.attnum AS attnum
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public'
          AND cl.relkind = 'r'
          AND NOT a.attisdropped
          AND a.attnum > 0
          AND (a.attname ~ 'dedup(e)?_key' OR a.attname = 'source_reference_id')
      ) d
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_index i
        WHERE i.indrelid = d.relid
          AND i.indisunique
          AND i.indisvalid
          AND d.attnum = ANY(i.indkey)
      )
    )
  );
$$;

-- Introspection-only, but there's no reason clients should ever call it.
REVOKE EXECUTE ON FUNCTION public.db_invariant_report() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.db_invariant_report() TO service_role;
