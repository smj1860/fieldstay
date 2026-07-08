-- ─────────────────────────────────────────────────────────────────────────
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations against project vpmznjktllhmmbfnxuvk on 2026-07-08 that
-- this file's version is absent from supabase_migrations.schema_migrations.
-- Spot-checking the schema objects it defines (tables, columns, indexes,
-- functions, policies, enum values, dropped objects) against the live
-- database confirms they already exist — this SQL was applied previously,
-- most likely by hand or under a different, already-tracked migration
-- timestamp, and this file is a historical/duplicate copy rather than a
-- pending change. Do not assume `supabase db push` needs to run it, and
-- verify against the live schema before treating it as authoritative —
-- some statements here (UPDATEs, INSERTs, ALTER TYPE ... ADD VALUE) are
-- not safely re-runnable if actually executed again.
-- ─────────────────────────────────────────────────────────────────────────
-- Phase 10: flag confirmed bookings that overlap another confirmed booking
-- on the same property. Populated by detectAndFlagOverlaps() — see
-- lib/ical/conflict-detection.ts. Surfaced as a badge on the Bookings page.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS has_overlap_conflict boolean NOT NULL DEFAULT false;

-- Speeds up the per-property confirmed-booking scan that runs on every
-- iCal sync and every manual booking create/cancel.
CREATE INDEX IF NOT EXISTS idx_bookings_property_overlap_scan
  ON bookings (property_id, checkin_date, checkout_date)
  WHERE status = 'confirmed';
