-- CRIT-1: org_milestones — restrict writes to admin/manager/owner
DROP POLICY IF EXISTS "milestones_manage" ON public.org_milestones;
DROP POLICY IF EXISTS "milestones_select" ON public.org_milestones;

CREATE POLICY "org_milestones_select"
  ON public.org_milestones FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "org_milestones_manage"
  ON public.org_milestones FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

-- CRIT-2: revoke dangerous anon DML grants on reviews tables
REVOKE INSERT, UPDATE, DELETE ON public.reviews          FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.review_responses FROM anon;

DROP POLICY IF EXISTS "Org members can manage their review responses" ON public.review_responses;

CREATE POLICY "reviews_service_write"
  ON public.reviews FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]));

CREATE POLICY "review_responses_service_write"
  ON public.review_responses FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]));

-- MED-2: audit_events — restrict reads to org owners (SOC2)
DROP POLICY IF EXISTS "Org members can read audit events" ON public.audit_events;

CREATE POLICY "audit_events_select"
  ON public.audit_events FOR SELECT
  USING (
    org_id IS NOT NULL
    AND is_org_member(org_id, ARRAY['owner'::member_role])
  );
