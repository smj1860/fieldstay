-- ============================================================================
-- RLS perf: drop the redundant per-row is_org_member() branch from SELECT
-- policies.
--
-- Every SELECT policy below currently has the shape
--
--   USING ( is_org_member(org_id, ARRAY['admin','manager'])          -- (a)
--        OR org_id IN ( SELECT get_user_org_ids() ) )                -- (b)
--
-- Branch (b) is a strict superset of branch (a): both helpers filter
-- organization_members on user_id = auth.uid() AND invite_accepted_at IS NOT
-- NULL, and (b) matches membership in ANY role while (a) matches a subset of
-- roles. So (a) can never grant a row that (b) does not already grant.
--
-- The two branches differ enormously in cost, though. (b) is an InitPlan —
-- Postgres evaluates get_user_org_ids() ONCE per statement and hashes the
-- result. (a) takes the row's org_id as an argument, so it cannot be hoisted:
-- it re-executes an EXISTS probe against organization_members FOR EVERY
-- CANDIDATE ROW, and because it is listed first in the OR, it runs before the
-- cheap branch gets a chance to short-circuit. On large scans (bookings,
-- work_orders, checklist_instance_items...) this is the dominant RLS cost.
--
-- This migration recreates each SELECT policy with branch (a) removed and
-- every other branch (crew-access subqueries, is_system flags, self-access)
-- preserved verbatim. Write policies (INSERT/UPDATE/DELETE) are untouched —
-- there is_org_member() does real role enforcement.
--
-- Policy list sourced from live pg_policies on project vpmznjktllhmmbfnxuvk
-- (2026-07-23): all 29 SELECT policies containing both is_org_member() and
-- get_user_org_ids().
-- ============================================================================

-- ── Simple org-scoped tables: qual becomes the cached org check only ────────

DROP POLICY IF EXISTS "asset_depreciation_entries_select" ON asset_depreciation_entries;
CREATE POLICY "asset_depreciation_entries_select" ON asset_depreciation_entries FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "assignment_outcomes_select" ON assignment_outcomes;
CREATE POLICY "assignment_outcomes_select" ON assignment_outcomes FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "bookings_select" ON bookings;
CREATE POLICY "bookings_select" ON bookings FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "checklist_templates_select" ON checklist_templates;
CREATE POLICY "checklist_templates_select" ON checklist_templates FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "communication_logs_select" ON communication_logs;
CREATE POLICY "communication_logs_select" ON communication_logs FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "inventory_count_drafts_select" ON inventory_count_drafts;
CREATE POLICY "inventory_count_drafts_select" ON inventory_count_drafts FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "maintenance_schedules_select" ON maintenance_schedules;
CREATE POLICY "maintenance_schedules_select" ON maintenance_schedules FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "org_milestones_select" ON org_milestones;
CREATE POLICY "org_milestones_select" ON org_milestones FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "property_owners_select" ON property_owners;
CREATE POLICY "property_owners_select" ON property_owners FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "purchase_orders_select" ON purchase_orders;
CREATE POLICY "purchase_orders_select" ON purchase_orders FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "quote_requests_select" ON quote_requests;
CREATE POLICY "quote_requests_select" ON quote_requests FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "vendor_compliance_documents_select" ON vendor_compliance_documents;
CREATE POLICY "vendor_compliance_documents_select" ON vendor_compliance_documents FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "vendors_select" ON vendors;
CREATE POLICY "vendors_select" ON vendors FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- ── Tables with additional crew / self-access branches (preserved) ──────────

DROP POLICY IF EXISTS "checklist_instance_items_select" ON checklist_instance_items;
CREATE POLICY "checklist_instance_items_select" ON checklist_instance_items FOR SELECT
  USING (
    instance_id IN (
      SELECT ci.id
      FROM checklist_instances ci
      JOIN turnover_assignments ta ON ta.turnover_id = ci.turnover_id
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = (SELECT auth.uid())
    )
    OR instance_id IN (
      SELECT ci.id
      FROM checklist_instances ci
      WHERE ci.org_id IN (SELECT get_user_org_ids())
    )
  );

DROP POLICY IF EXISTS "checklist_instances_select" ON checklist_instances;
CREATE POLICY "checklist_instances_select" ON checklist_instances FOR SELECT
  USING (
    turnover_id IN (
      SELECT ta.turnover_id
      FROM turnover_assignments ta
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = (SELECT auth.uid())
    )
    OR org_id IN (SELECT get_user_org_ids())
  );

DROP POLICY IF EXISTS "checklist_template_items_select" ON checklist_template_items;
CREATE POLICY "checklist_template_items_select" ON checklist_template_items FOR SELECT
  USING (
    template_id IN (
      SELECT checklist_templates.id
      FROM checklist_templates
      WHERE checklist_templates.org_id IN (SELECT get_user_org_ids())
    )
  );

DROP POLICY IF EXISTS "checklist_template_sections_select" ON checklist_template_sections;
CREATE POLICY "checklist_template_sections_select" ON checklist_template_sections FOR SELECT
  USING (
    template_id IN (
      SELECT checklist_templates.id
      FROM checklist_templates
      WHERE checklist_templates.org_id IN (SELECT get_user_org_ids())
    )
  );

DROP POLICY IF EXISTS "crew_availability_select" ON crew_availability;
CREATE POLICY "crew_availability_select" ON crew_availability FOR SELECT
  USING (
    crew_member_id IN (
      SELECT crew_members.id
      FROM crew_members
      WHERE crew_members.user_id = (SELECT auth.uid())
    )
    OR org_id IN (SELECT get_user_org_ids())
  );

DROP POLICY IF EXISTS "crew_members_select" ON crew_members;
CREATE POLICY "crew_members_select" ON crew_members FOR SELECT
  USING (
    org_id IN (SELECT get_user_org_ids())
    OR user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "inventory_count_draft_items_select" ON inventory_count_draft_items;
CREATE POLICY "inventory_count_draft_items_select" ON inventory_count_draft_items FOR SELECT
  USING (
    draft_id IN (
      SELECT inventory_count_drafts.id
      FROM inventory_count_drafts
      WHERE inventory_count_drafts.org_id IN (SELECT get_user_org_ids())
    )
  );

DROP POLICY IF EXISTS "inventory_items_select" ON inventory_items;
CREATE POLICY "inventory_items_select" ON inventory_items FOR SELECT
  USING (
    property_id IN (
      SELECT DISTINCT t.property_id
      FROM turnovers t
      JOIN turnover_assignments ta ON ta.turnover_id = t.id
      JOIN crew_members cm ON ta.crew_member_id = cm.id
      WHERE cm.user_id = (SELECT auth.uid())
    )
    OR org_id IN (SELECT get_user_org_ids())
  );

DROP POLICY IF EXISTS "maintenance_schedule_template_items_select" ON maintenance_schedule_template_items;
CREATE POLICY "maintenance_schedule_template_items_select" ON maintenance_schedule_template_items FOR SELECT
  USING (
    template_id IN (
      SELECT maintenance_schedule_templates.id
      FROM maintenance_schedule_templates
      WHERE maintenance_schedule_templates.org_id IN (SELECT get_user_org_ids())
         OR maintenance_schedule_templates.is_system = true
    )
  );

DROP POLICY IF EXISTS "maintenance_schedule_templates_select" ON maintenance_schedule_templates;
CREATE POLICY "maintenance_schedule_templates_select" ON maintenance_schedule_templates FOR SELECT
  USING (
    org_id IN (SELECT get_user_org_ids())
    OR is_system = true
  );

DROP POLICY IF EXISTS "properties_select" ON properties;
CREATE POLICY "properties_select" ON properties FOR SELECT
  USING (
    org_id IN (SELECT get_user_org_ids())
    OR id IN (
      SELECT DISTINCT t.property_id
      FROM turnovers t
      JOIN turnover_assignments ta ON ta.turnover_id = t.id
      JOIN crew_members cm ON cm.id = ta.crew_member_id
      WHERE cm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "property_assets_select" ON property_assets;
CREATE POLICY "property_assets_select" ON property_assets FOR SELECT
  USING (
    org_id IN (SELECT get_user_org_ids())
    OR (
      EXISTS (
        SELECT 1 FROM properties p
        WHERE p.id = property_assets.property_id
          AND p.org_id = property_assets.org_id
      )
      AND (
        property_id IN (
          SELECT DISTINCT t.property_id
          FROM turnovers t
          JOIN turnover_assignments ta ON ta.turnover_id = t.id
          JOIN crew_members cm ON ta.crew_member_id = cm.id
          WHERE cm.user_id = (SELECT auth.uid())
            AND cm.org_id = property_assets.org_id
        )
        OR property_id IN (
          SELECT wo.property_id
          FROM work_orders wo
          JOIN crew_members cm ON wo.assigned_crew_member_id = cm.id
          WHERE cm.user_id = (SELECT auth.uid())
            AND cm.org_id = property_assets.org_id
        )
      )
    )
  );

DROP POLICY IF EXISTS "turnover_assignments_select" ON turnover_assignments;
CREATE POLICY "turnover_assignments_select" ON turnover_assignments FOR SELECT
  USING (
    crew_member_id IN (
      SELECT crew_members.id
      FROM crew_members
      WHERE crew_members.user_id = (SELECT auth.uid())
    )
    OR org_id IN (SELECT get_user_org_ids())
  );

DROP POLICY IF EXISTS "turnovers_select" ON turnovers;
CREATE POLICY "turnovers_select" ON turnovers FOR SELECT
  USING (
    id IN (SELECT get_crew_turnover_ids())
    OR org_id IN (SELECT get_user_org_ids())
  );

DROP POLICY IF EXISTS "work_order_photos_select" ON work_order_photos;
CREATE POLICY "work_order_photos_select" ON work_order_photos FOR SELECT
  USING (
    work_order_id IN (
      SELECT work_orders.id
      FROM work_orders
      WHERE work_orders.org_id IN (SELECT get_user_org_ids())
    )
  );

DROP POLICY IF EXISTS "work_orders_select" ON work_orders;
CREATE POLICY "work_orders_select" ON work_orders FOR SELECT
  USING (
    org_id IN (SELECT get_user_org_ids())
    OR assigned_crew_member_id IN (
      SELECT crew_members.id
      FROM crew_members
      WHERE crew_members.user_id = (SELECT auth.uid())
    )
  );
