-- Properties SELECT policy is missing the crew-assignment path.
-- Crew members need to read properties for their assigned turnovers
-- (property name, address for navigation). Matches inventory_items pattern.

DROP POLICY IF EXISTS properties_select ON properties;

CREATE POLICY properties_select ON properties
  FOR SELECT USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    OR (org_id IN (SELECT get_user_org_ids()))
    OR (id IN (
      SELECT DISTINCT t.property_id
      FROM turnovers t
      JOIN turnover_assignments ta ON ta.turnover_id = t.id
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = (SELECT auth.uid())
    ))
  );
