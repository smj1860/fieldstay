-- Migration: ownerrez_upsert_unique_constraints
-- Version:   20260611155941
--
-- AUDIT REMEDIATION: Hard blocker identified in OwnerRez integration readiness audit.
--
-- The .upsert(rows, { onConflict: 'external_id,external_source' }) calls in
-- initial-sync.ts and incremental-sync.ts require a UNIQUE constraint to exist
-- on the conflict-target columns. Without this, PostgreSQL throws:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- causing every sync run to fail at the data write step — no properties or
-- bookings are written on any sync pass.
--
-- Partial indexes (WHERE NOT NULL) avoid constraint violations on the large
-- number of legacy rows that have no external_id (iCal bookings, manually
-- created properties). Only OwnerRez-sourced rows carry non-null values.
--
-- These indexes are also used by all future PMS integrations (Uplisting, Guesty,
-- Hostaway) that follow the same external_id / external_source upsert pattern.

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_external_source
  ON public.bookings(external_id, external_source)
  WHERE external_id IS NOT NULL AND external_source IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_external_source
  ON public.properties(external_id, external_source)
  WHERE external_id IS NOT NULL AND external_source IS NOT NULL;

COMMENT ON INDEX idx_bookings_external_source IS
  'Required for OwnerRez (and future PMS) upsert idempotency.
   Enables ON CONFLICT (external_id, external_source) DO UPDATE
   in initial-sync.ts and incremental-sync.ts.';

COMMENT ON INDEX idx_properties_external_source IS
  'Required for OwnerRez (and future PMS) upsert idempotency.
   Enables ON CONFLICT (external_id, external_source) DO UPDATE
   in initial-sync.ts and incremental-sync.ts.';
