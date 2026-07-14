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
