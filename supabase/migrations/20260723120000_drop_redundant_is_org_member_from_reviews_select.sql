-- Follow-up to 20260723090000_drop_redundant_is_org_member_from_select_policies:
-- reviews_select has the same redundant per-row is_org_member() first branch,
-- but its cacheable branch is an INLINE membership subquery rather than
-- get_user_org_ids(), so the original policy sweep (which grepped pg_policies
-- for both function names) didn't catch it.
--
-- Live qual (2026-07-23):
--   is_org_member(org_id, ARRAY['admin','owner'])                    -- per-row
--   OR org_id IN ( SELECT org_id FROM organization_members
--                  WHERE user_id = (SELECT auth.uid()) )             -- InitPlan
--
-- The inline branch matches ANY membership row (it does not filter on
-- invite_accepted_at, unlike get_user_org_ids), so it is a strict superset
-- of the is_org_member branch — which additionally requires an accepted
-- invite and a role match. Dropping the first branch changes nothing about
-- who can read reviews; the inline branch is kept VERBATIM to avoid
-- narrowing existing access.

DROP POLICY IF EXISTS "reviews_select" ON reviews;
CREATE POLICY "reviews_select" ON reviews FOR SELECT
  USING (
    org_id IN (
      SELECT organization_members.org_id
      FROM organization_members
      WHERE organization_members.user_id = (SELECT auth.uid())
    )
  );
