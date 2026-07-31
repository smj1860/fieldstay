-- db_invariant_report(): four new sections, one per class of defect the
-- 2026-07-30 pre-launch audit found that no existing check could see.
-- Consumed by scripts/check-db-invariants.mjs (CI job `db-invariants`).
--
--   6. policies_without_grant       — H1. A table can have perfect RLS
--      policies and still deny every query, because Postgres evaluates the
--      GRANT first. This shipped twice (20260710200000, and again on nine
--      tables incl. the entire notification bell). Any permissive policy
--      targeting `authenticated` or PUBLIC must be backed by the matching
--      privilege.
--   7. orgs_without_members         — B3. An organization with zero
--      organization_members rows is invisible to RLS forever: unreachable,
--      unpurgeable, and still holding guest PII. Two exist in production.
--   8. storage_policies_not_org_scoped / storage_buckets_without_policies —
--      B2. storage.objects lives outside the `public` schema, so every
--      existing section of this report was blind to it. The compliance-docs
--      policies qualified on bucket_id alone (any tenant could read/delete
--      any other tenant's vendor COIs) and two buckets had no policies at
--      all — neither state was visible to CI.
--   9. org_id_columns_without_fk    — a table carrying org_id with no FK to
--      organizations keeps its rows after the org is deleted, orphaned
--      exactly like #7 one level down.
--
-- Privilege matching notes for section 6:
--   * DELETE is table-level only, so it uses has_table_privilege.
--     SELECT/INSERT/UPDATE are column-grantable, so they use
--     has_any_column_privilege — this is what lets the deliberately
--     column-restricted `GRANT UPDATE (read_at) ON notifications` pass.
--   * Deny policies (USING false / WITH CHECK false, e.g. oauth_states_deny_all,
--     audit_events_deny_update) are skipped: a policy that permits nothing
--     needs no grant behind it.
--   * Restrictive policies are skipped for the same reason — they only ever
--     subtract.
--   * service_role-only policies are skipped: service_role holds BYPASSRLS.

CREATE OR REPLACE FUNCTION public.db_invariant_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH member_facing_policies AS (
    SELECT
      cl.relname AS tbl,
      p.polname,
      p.polcmd,
      pg_catalog.pg_get_expr(p.polqual,      p.polrelid) AS qual,
      pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS wcheck
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class     cl ON cl.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n  ON n.oid  = cl.relnamespace
    WHERE n.nspname = 'public'
      AND p.polpermissive
      AND (
        p.polroles = '{0}'::oid[]                      -- PUBLIC
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles r
          WHERE r.oid = ANY(p.polroles) AND r.rolname = 'authenticated'
        )
      )
  ),
  required_privileges AS (
    SELECT
      f.tbl,
      f.polname,
      pg_catalog.unnest(
        CASE f.polcmd
          WHEN 'r' THEN ARRAY['SELECT']
          WHEN 'a' THEN ARRAY['INSERT']
          WHEN 'w' THEN ARRAY['UPDATE']
          WHEN 'd' THEN ARRAY['DELETE']
          ELSE          ARRAY['SELECT','INSERT','UPDATE','DELETE']
        END
      ) AS priv
    FROM member_facing_policies f
    WHERE coalesce(f.qual,   '') <> 'false'
      AND coalesce(f.wcheck, '') <> 'false'
  ),
  storage_policies AS (
    SELECT
      p.polname,
      CASE p.polcmd
        WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL'
      END AS cmd,
      coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
        || ' ' ||
      coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') AS expr
    FROM pg_catalog.pg_policy p
    WHERE p.polrelid = 'storage.objects'::regclass
      AND p.polpermissive
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles r
        WHERE r.oid = ANY(p.polroles) AND r.rolname = 'service_role'
      )
  )
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
    ),
    'policies_without_grant', (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object('table', r.tbl, 'policy', r.polname, 'privilege', r.priv)
          ORDER BY r.tbl, r.polname, r.priv
        ),
        '[]'::jsonb
      )
      FROM required_privileges r
      WHERE CASE
        WHEN r.priv = 'DELETE'
          THEN NOT pg_catalog.has_table_privilege('authenticated', ('public.' || r.tbl)::regclass, 'DELETE')
        ELSE NOT pg_catalog.has_any_column_privilege('authenticated', ('public.' || r.tbl)::regclass, r.priv)
      END
    ),
    'orgs_without_members', (
      SELECT coalesce(jsonb_agg(o.id ORDER BY o.id), '[]'::jsonb)
      FROM public.organizations o
      WHERE NOT EXISTS (
        SELECT 1 FROM public.organization_members m WHERE m.org_id = o.id
      )
    ),
    'storage_policies_not_org_scoped', (
      -- A storage policy must narrow by owning org, not just by bucket. The
      -- recognized forms are the org-prefix helper, the two canonical org
      -- helpers, and the crew equivalent — anything else (a bare
      -- `bucket_id = '…'`) is the B2 shape.
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object('policy', s.polname, 'command', s.cmd)
          ORDER BY s.polname, s.cmd
        ),
        '[]'::jsonb
      )
      FROM storage_policies s
      WHERE s.expr !~ 'storage_org_prefix|get_user_org_ids|is_org_member|get_crew_org_ids'
    ),
    'storage_buckets_without_policies', (
      SELECT coalesce(jsonb_agg(b.id ORDER BY b.id), '[]'::jsonb)
      FROM storage.buckets b
      WHERE NOT EXISTS (
        SELECT 1 FROM storage_policies s WHERE s.expr LIKE '%''' || b.id || '''%'
      )
    ),
    'org_id_columns_without_fk', (
      SELECT coalesce(jsonb_agg(t.relname ORDER BY t.relname), '[]'::jsonb)
      FROM pg_catalog.pg_class t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = t.oid AND a.attname = 'org_id'
       AND NOT a.attisdropped AND a.attnum > 0
      WHERE n.nspname = 'public'
        AND t.relkind = 'r'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = t.oid
            AND c.contype  = 'f'
            AND a.attnum   = ANY(c.conkey)
        )
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.db_invariant_report() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.db_invariant_report() TO service_role;
