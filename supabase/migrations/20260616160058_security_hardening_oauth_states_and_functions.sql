
-- ── 1. oauth_states: revoke all PostgREST access ─────────────────────────────
-- This table is only ever touched by service role (OAuth callback route).
-- No authenticated or anonymous user should be able to reach it via the API.
REVOKE ALL ON public.oauth_states FROM anon, authenticated;

-- ── 2. Anon-callable SECURITY DEFINER functions ───────────────────────────────
-- These are data migration/backfill functions with no business being
-- callable by unauthenticated users.
REVOKE EXECUTE ON FUNCTION public.populate_checklist_item_turnover_id() FROM anon;
REVOKE EXECUTE ON FUNCTION public.populate_turnover_assignment_denorm() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_turnover_assignment_property_id() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_turnover_assignment_user_id() FROM anon;

-- ── 3. Add WITH CHECK to manage policies missing it ───────────────────────────
-- FOR ALL policies without WITH CHECK enforce RLS on reads but not writes.
-- A crafted INSERT could sneak in a row with a different org_id.

-- bookings_manage
DROP POLICY IF EXISTS bookings_manage ON public.bookings;
CREATE POLICY bookings_manage ON public.bookings FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- crew_manage
DROP POLICY IF EXISTS crew_manage ON public.crew_members;
CREATE POLICY crew_manage ON public.crew_members FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- inventory_items_manage
DROP POLICY IF EXISTS inventory_items_manage ON public.inventory_items;
CREATE POLICY inventory_items_manage ON public.inventory_items FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- turnovers_manage
DROP POLICY IF EXISTS turnovers_manage ON public.turnovers;
CREATE POLICY turnovers_manage ON public.turnovers FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- vendors_manage
DROP POLICY IF EXISTS vendors_manage ON public.vendors;
CREATE POLICY vendors_manage ON public.vendors FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- work_orders_manage
DROP POLICY IF EXISTS work_orders_manage ON public.work_orders;
CREATE POLICY work_orders_manage ON public.work_orders FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
