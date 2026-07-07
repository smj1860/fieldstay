-- The SELECT policy on checklist_instance_items is missing the crew-member
-- path. Crew members can read checklist_instances (that policy correctly
-- checks turnover_assignments) but not the items within them.
-- This migration adds the equivalent crew-assignment condition.

DROP POLICY IF EXISTS checklist_instance_items_select ON checklist_instance_items;

CREATE POLICY checklist_instance_items_select ON checklist_instance_items
  FOR SELECT USING (
    -- PM/admin path: org member
    (instance_id IN (
      SELECT ci.id FROM checklist_instances ci
      WHERE is_org_member(ci.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    ))
    OR
    -- Crew path: assigned to the turnover this instance belongs to
    (instance_id IN (
      SELECT ci.id FROM checklist_instances ci
      JOIN turnover_assignments ta ON ta.turnover_id = ci.turnover_id
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = (SELECT auth.uid())
    ))
    OR
    -- Org member fallback
    (instance_id IN (
      SELECT ci.id FROM checklist_instances ci
      WHERE ci.org_id IN (SELECT get_user_org_ids())
    ))
  );
