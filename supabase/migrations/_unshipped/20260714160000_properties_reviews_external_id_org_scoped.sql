-- SUPERSEDED — moved to _unshipped/ during the 2026-07-28 migration-drift
-- reconciliation (Task 4). Confirmed via Supabase MCP list_migrations that
-- this file's version was never recorded in supabase_migrations.schema_migrations,
-- and via live schema introspection (information_schema.tables/columns,
-- pg_proc, pg_indexes) that every table/column/index/function/policy this
-- file targets already exists in the live database — applied under a
-- different, real-timestamped migration that superseded this draft. Kept
-- for historical reference only; do not run.
-- ---------------------------------------------------------------------------

-- Fix cross-tenant property/review takeover: properties.external_id and
-- reviews.external_id are only unique per the PMS account they came from
-- (Hospitable/Hostaway/OwnerRez listing and review IDs are commonly small
-- per-account sequential integers), not globally. The old
-- (external_id, external_source) constraints meant two different orgs'
-- PMS connections reusing the same external_id silently overwrote each
-- other's property/review row on every sync -- reassigning org_id and
-- dragging wifi password, access instructions, house manual (properties)
-- or guest name / review text (reviews) to the wrong tenant. The property
-- overwrite additionally got logged into the *attacking* org's own
-- audit_events via logContentOverwrites(), leaking the victim's previous
-- content.
--
-- Mirrors the identical fix already applied to bookings
-- (20260714130000_bookings_external_id_org_scoped.sql) and crew_members
-- (20260704000001_crew_members_external_columns.sql /
-- 20260707190000_crew_members_external_unique.sql).

ALTER TABLE public.properties
  DROP CONSTRAINT IF EXISTS uq_properties_external_id_source;

ALTER TABLE public.properties
  ADD CONSTRAINT uq_properties_org_external_id_source
  UNIQUE (org_id, external_id, external_source);

ALTER TABLE public.reviews
  DROP CONSTRAINT IF EXISTS reviews_external_id_external_source_key;

ALTER TABLE public.reviews
  ADD CONSTRAINT reviews_org_id_external_id_external_source_key
  UNIQUE (org_id, external_id, external_source);
