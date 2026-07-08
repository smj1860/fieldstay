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
-- CLAUDE_57_0: Capital planning owner sharing + asset replacement status
--
-- property_owners.share_capital_plan
--   PM-controlled flag. When true, the owner's portal shows their
--   property's projected CapEx alongside the financial summary.
--   Defaults false — opt-in, never opt-out-by-surprise.
--
-- property_assets.replacement_status
--   Tracks PM disposition on projected replacements.
--   'projected'  — default, system-generated estimate
--   'budgeted'   — PM has allocated funds
--   'approved'   — owner has approved the spend
--   'deferred'   — PM has decided to push this out
--   Check constraint prevents arbitrary values.

ALTER TABLE property_owners
  ADD COLUMN IF NOT EXISTS share_capital_plan boolean NOT NULL DEFAULT false;

ALTER TABLE property_assets
  ADD COLUMN IF NOT EXISTS replacement_status text NOT NULL DEFAULT 'projected'
    CONSTRAINT property_assets_replacement_status_check
      CHECK (replacement_status IN ('projected', 'budgeted', 'approved', 'deferred'));

-- Index: capital planning page filters by status and by property when
-- rendering the per-property breakdown. Partial index omits the
-- default 'projected' value — they are the majority and don't benefit
-- from indexing in filtered views.
CREATE INDEX IF NOT EXISTS idx_property_assets_replacement_status
  ON property_assets (org_id, replacement_status)
  WHERE replacement_status != 'projected';
