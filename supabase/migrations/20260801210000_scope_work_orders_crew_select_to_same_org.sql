-- ============================================================================
-- TENANT ISOLATION: the crew branch of work_orders_select was not org-scoped.
--
-- The policy read:
--
--   org_id IN (SELECT get_user_org_ids())
--   OR assigned_crew_member_id IN (
--        SELECT id FROM crew_members WHERE user_id = auth.uid()
--      )
--
-- The second branch is an OR with NO reference to the work order's org at all.
-- It exists because a crew member does not necessarily have an
-- organization_members row — crew live in crew_members — so get_user_org_ids()
-- alone would hide their own assigned work from them.
--
-- But as written it says: "you may read ANY work order, in ANY organization,
-- whose assigned_crew_member_id happens to be one of your crew_members rows."
-- Nothing constrained that work order to your own tenant. Any code path that
-- wrote a foreign org's crew id onto a work order — and two server actions
-- accepted that id straight from the client without checking, which is fixed
-- alongside this migration — made that work order readable by the OTHER
-- tenant's crew user: title, description, notes, costs, property linkage.
--
-- The fix is to require the crew_members row to belong to the SAME org as the
-- work order. A crew member's legitimate access is unchanged (their own org's
-- work orders assigned to them); the cross-tenant path disappears.
--
-- crew_members.org_id is NOT NULL, so the added predicate can never be
-- NULL-skipped. Verified before applying: ZERO work_orders rows currently have
-- an assigned_crew_member_id whose crew_members.org_id differs from the work
-- order's org_id, so this tightening revokes no access that anyone has today.
--
-- This is the real boundary. The app-level verification added in the same
-- change (checkCrewMemberAssignable) stops the bad row being written in the
-- first place, but RLS is what has to hold when something else writes it —
-- a migration backfill, the Supabase dashboard, a future code path.
-- ============================================================================

DROP POLICY IF EXISTS "work_orders_select" ON public.work_orders;

CREATE POLICY "work_orders_select"
  ON public.work_orders FOR SELECT
  USING (
    org_id IN (SELECT get_user_org_ids())
    OR assigned_crew_member_id IN (
         SELECT cm.id
           FROM public.crew_members cm
          WHERE cm.user_id = (SELECT auth.uid())
            AND cm.org_id  = work_orders.org_id
       )
  );

NOTIFY pgrst, 'reload schema';
