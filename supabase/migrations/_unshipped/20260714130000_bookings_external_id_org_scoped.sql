-- SUPERSEDED — moved to _unshipped/ during the 2026-07-28 migration-drift
-- reconciliation (Task 4). Confirmed via Supabase MCP list_migrations that
-- this file's version was never recorded in supabase_migrations.schema_migrations,
-- and via live schema introspection (information_schema.tables/columns,
-- pg_proc, pg_indexes) that every table/column/index/function/policy this
-- file targets already exists in the live database — applied under a
-- different, real-timestamped migration that superseded this draft. Kept
-- for historical reference only; do not run.
-- ---------------------------------------------------------------------------

-- Fix cross-tenant booking collision: bookings.external_id is only unique
-- per the PMS account it came from (e.g. OwnerRez booking IDs are per-account
-- sequential integers), not globally. The old (external_id, external_source)
-- constraint meant two different orgs' PMS connections reusing the same
-- external_id silently overwrote each other's booking row (org_id,
-- property_id, guest data) on every sync, and — since this session wired
-- OwnerRez bookings to fire booking/confirmed for automatic revenue posting
-- — could misattribute a revenue transaction to the wrong org.
--
-- Mirrors the same fix already applied to crew_members for the identical
-- class of bug (see 20260704000001_crew_members_external_columns.sql /
-- 20260707190000_crew_members_external_unique.sql).
ALTER TABLE public.bookings
  DROP CONSTRAINT bookings_external_id_external_source_key;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_org_id_external_id_external_source_key
  UNIQUE (org_id, external_id, external_source);
