-- Crew members have no organization_members row, so the existing
-- property_assets_select policy (org_id IN get_user_org_ids()) never
-- matches them. Grant crew read/insert access scoped to properties they're
-- currently assigned to, mirroring the inventory_items_update pattern
-- (turnover_assignments join) plus assigned work orders — matching the
-- "assigned properties" set already used by the crew home page
-- (app/crew/page.tsx's assignedPropertyIds).
CREATE POLICY "property_assets_crew_select"
  ON public.property_assets FOR SELECT
  USING (
    property_id IN (
      SELECT DISTINCT t.property_id
      FROM turnovers t
      JOIN turnover_assignments ta ON ta.turnover_id = t.id
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = (select auth.uid())
    )
    OR property_id IN (
      SELECT wo.property_id
      FROM work_orders wo
      JOIN crew_members cm ON wo.assigned_crew_member_id = cm.id
      WHERE cm.user_id = (select auth.uid())
    )
  );

CREATE POLICY "property_assets_crew_insert"
  ON public.property_assets FOR INSERT
  WITH CHECK (
    org_id IN (
      SELECT crew_members.org_id FROM crew_members
      WHERE crew_members.user_id = (select auth.uid())
    )
    AND (
      property_id IN (
        SELECT DISTINCT t.property_id
        FROM turnovers t
        JOIN turnover_assignments ta ON ta.turnover_id = t.id
        JOIN crew_members cm ON ta.crew_member_id = cm.id
        WHERE cm.user_id = (select auth.uid())
      )
      OR property_id IN (
        SELECT wo.property_id
        FROM work_orders wo
        JOIN crew_members cm ON wo.assigned_crew_member_id = cm.id
        WHERE cm.user_id = (select auth.uid())
      )
    )
  );
