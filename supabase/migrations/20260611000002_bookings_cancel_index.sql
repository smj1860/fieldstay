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
-- Speed up the turnover-cascade lookup in cancelBooking().
CREATE INDEX IF NOT EXISTS idx_turnovers_booking_id
  ON public.turnovers(booking_id)
  WHERE booking_id IS NOT NULL;

-- Allow a 'booking_cancellation' reversal row alongside the original
-- 'booking_revenue' / 'uplisting_booking' row for the same booking.
-- (source_reference_id, source) is UNIQUE, so the reversal needs its own
-- distinct `source` value rather than reusing 'booking_revenue'.
ALTER TABLE public.owner_transactions
  DROP CONSTRAINT IF EXISTS owner_transactions_source_check;

ALTER TABLE public.owner_transactions
  ADD CONSTRAINT owner_transactions_source_check
  CHECK (source = ANY (ARRAY[
    'manual'::text,
    'wo_completion'::text,
    'booking_revenue'::text,
    'uplisting_booking'::text,
    'inventory_purchase'::text,
    'cleaning_fee'::text,
    'booking_cancellation'::text
  ]));
