
-- Add missing WITH CHECK clauses to UPDATE policies on guidebook tables.
-- Without these, an authenticated user could UPDATE a row they own and
-- mutate org_id to a different org, breaking tenant isolation.

-- ── guidebook_configurations ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "gc_org_members_update" ON guidebook_configurations;

CREATE POLICY "gc_org_members_update" ON guidebook_configurations
  FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()))
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

-- ── guidebook_sponsors ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "gs_org_members_update" ON guidebook_sponsors;

CREATE POLICY "gs_org_members_update" ON guidebook_sponsors
  FOR UPDATE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
