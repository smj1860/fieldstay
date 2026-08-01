-- ============================================================================
-- turnovers.crew_duration_minutes
--
-- RECONSTRUCTED 2026-08-01 from live migration history. This column was applied
-- to BOTH projects on 2026-07-31 (recorded as version 20260731174300, name
-- `20260731000000_turnover_crew_duration_minutes`) but the local .sql file was
-- never written or committed — there is no trace of it anywhere in git. It was
-- applied through MCP apply_migration without a corresponding repo file, which
-- is exactly the drift CLAUDE.md's migration-discipline rule exists to prevent:
-- live history and supabase/migrations/ silently disagreed, and nothing caught
-- it until scripts/check-type-drift.mjs failed on the merge (the column existed
-- in the database and in neither types/database.ts nor this directory).
--
-- The statement below is reproduced verbatim from
-- supabase_migrations.schema_migrations.statements for that version, so
-- replaying it against either project is a no-op (ADD COLUMN IF NOT EXISTS)
-- while a fresh project now gets the column it was always supposed to have.
--
-- Nothing in app/ or lib/ reads or writes this column yet — it is currently
-- unused groundwork. It is modelled in types/database.ts regardless, because
-- the type-drift gate compares the LIVE schema against the TS interfaces, not
-- against what the code happens to touch.
-- ============================================================================

ALTER TABLE turnovers
  ADD COLUMN IF NOT EXISTS crew_duration_minutes integer;
