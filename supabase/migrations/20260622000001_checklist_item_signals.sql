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
-- Bayesian Beta-Binomial signal tracking for checklist item photo requirements.
-- alpha = clean completions + prior (alpha0=2), beta = flagged completions + prior (beta0=1).
-- flag_probability and dynamic_photo_required are derived columns so the math
-- can never drift out of sync with alpha/beta.

CREATE TABLE checklist_item_signals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id            uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  section_name           text NOT NULL,
  task                   text NOT NULL,

  alpha                  numeric NOT NULL DEFAULT 2,
  beta                   numeric NOT NULL DEFAULT 1,

  flag_probability       numeric GENERATED ALWAYS AS (beta / (alpha + beta)) STORED,
  dynamic_photo_required boolean GENERATED ALWAYS AS (beta / (alpha + beta) >= 0.20) STORED,

  reason                 text NULL,

  total_completions      integer NOT NULL DEFAULT 0,
  total_flags            integer NOT NULL DEFAULT 0,

  computed_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (property_id, section_name, task)
);

ALTER TABLE checklist_item_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read own signals"
  ON checklist_item_signals FOR SELECT
  USING (is_org_member(org_id, ARRAY[
    'admin'::member_role, 'manager'::member_role, 'owner'::member_role
  ]));

CREATE POLICY "service role manages signals"
  ON checklist_item_signals FOR ALL TO service_role
  USING (true) WITH CHECK (true);

ALTER TABLE checklist_instance_items ADD COLUMN photo_reason text NULL;
