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
-- ============================================================
-- Timezone infrastructure + work order scheduled time
--
-- 1. properties.timezone  — IANA string, single source of truth
--    for all UTC conversions across turnovers, dispatch, cron.
--    Default 'America/New_York' — overwritten by PMS sync for
--    Hospitable/OwnerRez; PM confirms for manual properties.
--
-- 2. work_orders.scheduled_time — nullable TIME for same-day
--    flip scenarios where the vendor must complete work inside
--    a specific window (e.g. 11:00 AM – 3:00 PM).
-- ============================================================

-- 1. Property timezone
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';

COMMENT ON COLUMN public.properties.timezone IS
  'IANA timezone identifier (e.g. America/Chicago). Single source of truth for
   all UTC conversions: turnover window generation, Friction Forecaster scoring,
   crew/vendor dispatch messaging, pre-arrival email scheduling, guidebook display.
   Overwritten by PMS sync (Hospitable/OwnerRez). Defaults to America/New_York.';

-- 2. Work order scheduled time
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS scheduled_time TIME WITHOUT TIME ZONE;

COMMENT ON COLUMN public.work_orders.scheduled_time IS
  'Optional wall-clock time for same-day flip vendor dispatch scenarios.
   Combined with scheduled_date and the property timezone to communicate
   the available work window to the vendor (e.g. 11:00 AM – 3:00 PM CDT).
   NULL for standard (non-same-day-flip) work orders.';

-- No new RLS policies required — both columns inherit existing table policies.

-- Reload PostgREST schema cache so new columns are visible immediately
NOTIFY pgrst, 'reload schema';
