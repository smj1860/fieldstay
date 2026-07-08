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
-- ─────────────────────────────────────────────────────────────
-- TABLE: crew_feedback
-- Free-form feedback submitted by crew members from the crew PWA.
-- One row per submission. org_id + crew_member_id are derived
-- server-side from the authenticated session, never client-supplied.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crew_feedback (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crew_member_id UUID        NOT NULL REFERENCES crew_members(id)  ON DELETE CASCADE,
  property_id    UUID        REFERENCES properties(id) ON DELETE SET NULL,
  feedback_text  TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE crew_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crew_feedback_select" ON crew_feedback;
DROP POLICY IF EXISTS "crew_feedback_manage" ON crew_feedback;

-- Read: any member of the org (PMs review crew feedback)
CREATE POLICY "crew_feedback_select"
  ON crew_feedback FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- Manage: admins/managers (owner always passes). Crew submissions are
-- written via the service client in app/api/crew/feedback, which bypasses RLS.
CREATE POLICY "crew_feedback_manage"
  ON crew_feedback FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE INDEX IF NOT EXISTS crew_feedback_org_id_idx
  ON crew_feedback(org_id);

CREATE INDEX IF NOT EXISTS crew_feedback_crew_member_id_idx
  ON crew_feedback(crew_member_id);
