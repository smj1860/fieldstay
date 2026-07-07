-- TABLE: crew_feedback
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

CREATE POLICY "crew_feedback_select"
  ON crew_feedback FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "crew_feedback_manage"
  ON crew_feedback FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE INDEX IF NOT EXISTS crew_feedback_org_id_idx
  ON crew_feedback(org_id);

CREATE INDEX IF NOT EXISTS crew_feedback_crew_member_id_idx
  ON crew_feedback(crew_member_id);
