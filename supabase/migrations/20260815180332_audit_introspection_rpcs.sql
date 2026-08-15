-- Two introspection reads behind the audit gates. Same shape and same safety
-- argument as db_invariant_report() and migration_ledger_versions(): STABLE,
-- no DDL and no DML, provably read-only and therefore safe against production.

-- ── 1. migration_ledger_digests() ───────────────────────────────────────────
--
-- check-migration-ledger.mjs compares VERSION SETS and nothing else — it reads
-- the 14-character prefixes of supabase/migrations/*.sql and diffs them against
-- the versions in the ledger. It cannot see whether the SQL in a committed file
-- is the SQL that actually ran.
--
-- That hole is not theoretical. MCP apply_migration takes a query argument and
-- records whatever it was given; the local file is written separately, by hand.
-- On 2026-08-15 exactly that produced a file whose ~50-line header comment was
-- never applied. Harmless there, but the same path silently permits a file
-- whose DDL differs from the DDL that ran — at which point the repo can no
-- longer reproduce the database, which is the whole property the ledger gate
-- exists to protect.
--
-- Returns the raw applied SQL per version. Normalization happens in ONE place,
-- in the script, applied identically to both sides — the alternative (normalize
-- here, normalize again in JS) is two implementations that can disagree, and a
-- disagreement would be frozen into the baseline as if it were real drift.
-- ~640 kB across ~350 migrations, so returning it whole is cheap.
CREATE OR REPLACE FUNCTION public.migration_ledger_digests()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'version', m.version,
        'sql',     array_to_string(m.statements, E'\n')
      ) ORDER BY m.version
    ),
    '[]'::jsonb
  )
  FROM supabase_migrations.schema_migrations m;
$$;

REVOKE EXECUTE ON FUNCTION public.migration_ledger_digests() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.migration_ledger_digests() TO service_role;


-- ── 2. rls_policy_report() ──────────────────────────────────────────────────
--
-- db_invariant_report() proves RLS is ENABLED and that a table has at least one
-- policy. Neither is a statement about whether the policy is CORRECT, and the
-- gap between "has a policy" and "the policy expresses the right rule" is where
-- a cross-tenant leak lives.
--
-- This returns the per-policy facts needed to judge that, so the rules live in
-- scripts/check-rls-policy-semantics.mjs where they can be read and baselined:
--
--   roles         — a USING (true) policy is entirely fine TO service_role
--                   (which bypasses RLS anyway) and a leak TO public. The
--                   expression alone cannot tell those apart, and role is the
--                   dimension a hand-audit is most likely to skip.
--   permissive    — a RESTRICTIVE policy narrows; a PERMISSIVE one widens. A
--                   blanket-true PERMISSIVE policy defeats every other policy
--                   on the table, because permissive policies are OR-ed.
--   has_org_id    — whether org scoping is even applicable to the table.
--   qual/with_check — an UPDATE with USING but no WITH CHECK passes rows in and
--                   lets them be written to any value, including another org's.
CREATE OR REPLACE FUNCTION public.rls_policy_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table_name',  c.relname,
        'policy_name', p.polname,
        'cmd',         CASE p.polcmd
                         WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                         WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                         ELSE 'ALL' END,
        'permissive',  p.polpermissive,
        'roles',       coalesce(
                         (SELECT jsonb_agg(r.rolname ORDER BY r.rolname)
                            FROM pg_catalog.pg_roles r
                           WHERE r.oid = ANY (p.polroles)),
                         '["PUBLIC"]'::jsonb),
        'qual',        pg_catalog.pg_get_expr(p.polqual,      p.polrelid),
        'with_check',  pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid),
        'has_org_id',  EXISTS (
                         SELECT 1 FROM pg_catalog.pg_attribute a
                          WHERE a.attrelid = c.oid
                            AND a.attname  = 'org_id'
                            AND a.attnum > 0 AND NOT a.attisdropped)
      ) ORDER BY c.relname, p.polname
    ),
    '[]'::jsonb
  )
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class     c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public';
$$;

REVOKE EXECUTE ON FUNCTION public.rls_policy_report() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rls_policy_report() TO service_role;
