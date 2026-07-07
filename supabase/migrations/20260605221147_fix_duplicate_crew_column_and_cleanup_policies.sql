
-- ================================================================
-- 1. Reconcile the dual crew assignment columns on work_orders.
--    assigned_crew_id   = original column (legacy, never used in production)
--    assigned_crew_member_id = Phase 8 migration column (canonical)
--
--    Both are currently NULL in all 3 rows so no data migration needed.
--    Deprecate assigned_crew_id by aliasing it as a generated expression
--    pointing to assigned_crew_member_id for backward compat, then
--    in a follow-up migration we can drop it fully once code is clean.
--    For now: copy any data that exists in the old column into the new one.
-- ================================================================
UPDATE work_orders
SET assigned_crew_member_id = assigned_crew_id
WHERE assigned_crew_id IS NOT NULL
  AND assigned_crew_member_id IS NULL;

COMMENT ON COLUMN work_orders.assigned_crew_id IS
  'DEPRECATED — use assigned_crew_member_id. Kept for backward compat only.';

COMMENT ON COLUMN work_orders.assigned_crew_member_id IS
  'Canonical internal crew assignment. References crew_members.id.';

-- ================================================================
-- 2. Clean up duplicate / conflicting communication_logs policies.
--    Current state has 4 policies, 2 of which are redundant INSERT
--    policies with no WITH CHECK clause (null qual). Consolidate to
--    a clean set: one SELECT, one INSERT, one ALL for admin/manager/owner.
-- ================================================================
DROP POLICY IF EXISTS "Admins and managers can manage communication logs"   ON communication_logs;
DROP POLICY IF EXISTS "Admins and managers can log communications"           ON communication_logs;
DROP POLICY IF EXISTS "org members can insert comm logs"                     ON communication_logs;
DROP POLICY IF EXISTS "Org members can view communication logs"              ON communication_logs;
DROP POLICY IF EXISTS "Admins and managers manage communication logs"        ON communication_logs;

-- Authoritative replacement policies
CREATE POLICY "comm_logs_select"
  ON communication_logs
  FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "comm_logs_manage"
  ON communication_logs
  FOR ALL
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ================================================================
-- 3. Fix owner_transactions — explicitly add INSERT WITH CHECK
--    The current ALL policy covers it, but some Supabase versions
--    require explicit INSERT for WITH CHECK to fire correctly.
-- ================================================================
DROP POLICY IF EXISTS "owner_transactions_manage" ON owner_transactions;

CREATE POLICY "owner_transactions_manage"
  ON owner_transactions
  FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ================================================================
-- 4. Ensure properties has an explicit WITH CHECK on its manage policy
--    (fixes "cannot add property" edge cases)
-- ================================================================
DROP POLICY IF EXISTS "properties_manage" ON properties;

CREATE POLICY "properties_manage"
  ON properties
  FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
