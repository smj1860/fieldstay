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
-- Progressive Asset Discovery: extend property_assets with discovery/verification
-- fields, and let checklist_instance_items carry system-mandated, non-deletable
-- injected tasks for asset types not yet discovered on a property.

ALTER TABLE public.property_assets
  ADD COLUMN photo_url   text,
  ADD COLUMN is_na        boolean NOT NULL DEFAULT false,
  ADD COLUMN verified_at  timestamp with time zone;

-- Only one *active* row per (property_id, asset_type) drives discovery drop-off.
-- Historical/replaced assets (is_active = false) are exempt so the Asset Health
-- module can keep multiple rows per asset_type over a property's lifetime.
CREATE UNIQUE INDEX property_assets_property_active_type_idx
  ON public.property_assets (property_id, asset_type)
  WHERE is_active = true;

ALTER TABLE public.checklist_instance_items
  ADD COLUMN is_mandatory          boolean NOT NULL DEFAULT false,
  ADD COLUMN non_deletable         boolean NOT NULL DEFAULT false,
  ADD COLUMN asset_discovery_type  text;
