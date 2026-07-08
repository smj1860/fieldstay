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
-- Learned per-asset-type weights for health scoring. Start at the current
-- hardcoded 60/40 split so day-one behavior is unchanged; weights drift
-- toward whatever real repair data suggests via the nightly Bayesian nudge
-- in lib/inngest/functions/cron/asset-health.ts.

ALTER TABLE asset_type_standards
  ADD COLUMN age_weight       numeric NOT NULL DEFAULT 60
    CHECK (age_weight BETWEEN 30 AND 70),
  ADD COLUMN condition_weight numeric NOT NULL DEFAULT 40
    CHECK (condition_weight BETWEEN 30 AND 70),
  ADD COLUMN weight_updated_at timestamptz NULL;

ALTER TABLE asset_type_standards
  ADD CONSTRAINT asset_weights_sum_100
    CHECK (round(age_weight + condition_weight) = 100);
