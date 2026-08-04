-- migration_ledger_versions(): the read behind scripts/check-migration-ledger.mjs.
--
-- supabase_migrations.schema_migrations is the ledger `supabase db push`
-- consults to decide what is already applied. It lives outside `public`, so
-- PostgREST cannot reach it — hence this SECURITY DEFINER wrapper, the same
-- shape and the same safety argument as db_invariant_report(): LANGUAGE sql,
-- STABLE, no DDL and no DML, so it is provably read-only and safe to call
-- against production.
--
-- Why this exists: the 2026-08-03 audit (H10) found production's ledger and
-- supabase/migrations/ had diverged in BOTH directions — 36 local files never
-- recorded, 35 ledger rows with no local file. Cause: MCP apply_migration
-- records live history without writing a local file, and renumbering a local
-- file orphans the row already recorded under its old version. Neither is
-- visible from the repo, and the consequence is that `supabase db push`
-- replays or skips arbitrary migrations — including a revoke/restore pair
-- whose order matters.
--
-- Returns bare version strings; the caller diffs them against the filenames
-- in supabase/migrations/. Nothing here interprets them.

CREATE OR REPLACE FUNCTION public.migration_ledger_versions()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    jsonb_agg(m.version ORDER BY m.version),
    '[]'::jsonb
  )
  FROM supabase_migrations.schema_migrations m;
$$;

-- Introspection-only. Same posture as db_invariant_report(): no client has any
-- reason to read the migration ledger.
REVOKE EXECUTE ON FUNCTION public.migration_ledger_versions() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.migration_ledger_versions() TO service_role;
