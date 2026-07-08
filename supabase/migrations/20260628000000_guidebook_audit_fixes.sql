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
-- Guidebook audit remediation: pre-arrival email dedup column + deny-all
-- INSERT/DELETE policies on guidebook_configurations (service-role only).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS guidebook_pre_arrival_email_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_bookings_guidebook_pre_arrival_pending
  ON bookings (checkin_date)
  WHERE guidebook_pre_arrival_email_sent_at IS NULL;

CREATE POLICY "gc_restrict_insert"
  ON guidebook_configurations FOR INSERT
  WITH CHECK (false);

CREATE POLICY "gc_restrict_delete"
  ON guidebook_configurations FOR DELETE
  USING (false);
