-- SUPERSEDED — moved to _unshipped/ during the 2026-07-28 migration-drift
-- reconciliation (Task 4). Confirmed via Supabase MCP list_migrations that
-- this file's version was never recorded in supabase_migrations.schema_migrations,
-- and via live schema introspection (information_schema.tables/columns,
-- pg_proc, pg_indexes) that every table/column/index/function/policy this
-- file targets already exists in the live database — applied under a
-- different, real-timestamped migration that superseded this draft. Kept
-- for historical reference only; do not run.
-- ---------------------------------------------------------------------------

-- A room template can be flagged to auto-apply to every property's checklist
-- (e.g. a "Whole Home" walkthrough module that belongs on every turnover,
-- unlike opt-in rooms like "Bedroom" or "Screen Porch" that a PM adds via
-- the quantity picker). See FUTURE_ADDITIONS.md #2.

ALTER TABLE public.room_templates
  ADD COLUMN IF NOT EXISTS auto_include boolean NOT NULL DEFAULT false;
