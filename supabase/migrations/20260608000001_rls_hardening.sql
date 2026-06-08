-- Security audit remediation — Round 2
-- CRIT-1: org_milestones, CRIT-2: reviews/review_responses anon grants, MED-2: audit_events
--
-- NOTE: org_milestones and audit_events already had RLS enabled with policies that
-- were broader than intended (any org member could write milestones / read audit
-- events). Adding the audit's narrower policies alongside the old ones would be a
-- no-op — Postgres OR's permissive policies together, so the old permissive policy
-- would still win. We replace the old policies with the role-scoped ones instead so
-- the tightening actually takes effect.

-- ── CRIT-1: org_milestones — restrict writes to admin/manager/owner ─────────────
DROP POLICY IF EXISTS "milestones_manage" ON public.org_milestones;
DROP POLICY IF EXISTS "milestones_select" ON public.org_milestones;

CREATE POLICY "org_milestones_select"
  ON public.org_milestones FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "org_milestones_manage"
  ON public.org_milestones FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

-- ── CRIT-2: revoke dangerous anon DML grants on reviews tables ──────────────────
REVOKE INSERT, UPDATE, DELETE ON public.reviews          FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.review_responses FROM anon;

-- Replace the existing "any org member" review_responses write policy and add an
-- equivalent for reviews — both scoped to admin/owner (reputation management is a
-- leadership-level action). All app writes go through the service-role client in
-- Inngest functions / API routes, which bypasses RLS — these policies only govern
-- direct authenticated-client access.
DROP POLICY IF EXISTS "Org members can manage their review responses" ON public.review_responses;

CREATE POLICY "reviews_service_write"
  ON public.reviews FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]));

CREATE POLICY "review_responses_service_write"
  ON public.review_responses FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]));

-- ── MED-2: audit_events — restrict reads to org owners (SOC2) ───────────────────
DROP POLICY IF EXISTS "Org members can read audit events" ON public.audit_events;

CREATE POLICY "audit_events_select"
  ON public.audit_events FOR SELECT
  USING (
    org_id IS NOT NULL
    AND is_org_member(org_id, ARRAY['owner'::member_role])
  );
-- No INSERT policy = service role only (correct)
