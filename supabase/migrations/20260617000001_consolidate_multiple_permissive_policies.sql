-- ─────────────────────────────────────────────────────────────────────────
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations against project vpmznjktllhmmbfnxuvk on 2026-07-08 that
-- this file's version is absent from supabase_migrations.schema_migrations.
-- Spot-checking the schema objects it defines (tables, columns, indexes,
-- functions, policies, enum values, dropped objects) against the live
-- database confirms they already exist — this SQL was applied previously,
-- most likely by hand or under a different, already-tracked migration
-- timestamp, and this file is a historical/duplicate copy rather than a
-- pending change. Do not assume `supabase db push` needs to run it, and
-- verify against the live schema before treating it as authoritative —
-- some statements here (UPDATEs, INSERTs, ALTER TYPE ... ADD VALUE) are
-- not safely re-runnable if actually executed again.
-- ─────────────────────────────────────────────────────────────────────────
-- Task 1: Consolidate multiple permissive RLS policies
-- Generated migration: merges duplicate permissive policies per table/command
-- while preserving original authorization outcomes (split FOR ALL into per-command policies)

-- ============================================================
-- Table: asset_depreciation_entries
-- ============================================================
DROP POLICY IF EXISTS "depreciation_manage" ON asset_depreciation_entries;
DROP POLICY IF EXISTS "depreciation_select" ON asset_depreciation_entries;

CREATE POLICY "asset_depreciation_entries_select" ON asset_depreciation_entries FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "asset_depreciation_entries_insert" ON asset_depreciation_entries FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "asset_depreciation_entries_update" ON asset_depreciation_entries FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "asset_depreciation_entries_delete" ON asset_depreciation_entries FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: assignment_outcomes
-- ============================================================
DROP POLICY IF EXISTS "assignment_outcomes_manage" ON assignment_outcomes;
DROP POLICY IF EXISTS "assignment_outcomes_select" ON assignment_outcomes;

CREATE POLICY "assignment_outcomes_select" ON assignment_outcomes FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "assignment_outcomes_insert" ON assignment_outcomes FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "assignment_outcomes_update" ON assignment_outcomes FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "assignment_outcomes_delete" ON assignment_outcomes FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: bookings
-- ============================================================
DROP POLICY IF EXISTS "bookings_manage" ON bookings;
DROP POLICY IF EXISTS "bookings_select" ON bookings;

CREATE POLICY "bookings_select" ON bookings FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "bookings_insert" ON bookings FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "bookings_update" ON bookings FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "bookings_delete" ON bookings FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: checklist_instance_items
-- ============================================================
DROP POLICY IF EXISTS "instance_items_crew_update" ON checklist_instance_items;
DROP POLICY IF EXISTS "instance_items_manage" ON checklist_instance_items;
DROP POLICY IF EXISTS "instance_items_select" ON checklist_instance_items;

CREATE POLICY "checklist_instance_items_select" ON checklist_instance_items FOR SELECT
  USING (
    ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE (checklist_instances.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))))
  );

CREATE POLICY "checklist_instance_items_insert" ON checklist_instance_items FOR INSERT
  WITH CHECK (
    (instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "checklist_instance_items_update" ON checklist_instance_items FOR UPDATE
  USING (
    ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((instance_id IN ( SELECT ci.id
   FROM ((checklist_instances ci
     JOIN turnover_assignments ta ON ((ci.turnover_id = ta.turnover_id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))))
  )
  WITH CHECK (
    ((instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((instance_id IN ( SELECT ci.id
   FROM ((checklist_instances ci
     JOIN turnover_assignments ta ON ((ci.turnover_id = ta.turnover_id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))))
  );

CREATE POLICY "checklist_instance_items_delete" ON checklist_instance_items FOR DELETE
  USING (
    (instance_id IN ( SELECT checklist_instances.id
   FROM checklist_instances
  WHERE is_org_member(checklist_instances.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );


-- ============================================================
-- Table: checklist_instances
-- ============================================================
DROP POLICY IF EXISTS "checklist_instances_crew_select" ON checklist_instances;
DROP POLICY IF EXISTS "checklist_instances_manage" ON checklist_instances;
DROP POLICY IF EXISTS "checklist_instances_select" ON checklist_instances;

CREATE POLICY "checklist_instances_select" ON checklist_instances FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((turnover_id IN ( SELECT ta.turnover_id
   FROM (turnover_assignments ta
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "checklist_instances_insert" ON checklist_instances FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "checklist_instances_update" ON checklist_instances FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "checklist_instances_delete" ON checklist_instances FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: checklist_template_items
-- ============================================================
DROP POLICY IF EXISTS "template_items_manage" ON checklist_template_items;
DROP POLICY IF EXISTS "template_items_select" ON checklist_template_items;

CREATE POLICY "checklist_template_items_select" ON checklist_template_items FOR SELECT
  USING (
    ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE (checklist_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))))
  );

CREATE POLICY "checklist_template_items_insert" ON checklist_template_items FOR INSERT
  WITH CHECK (
    (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "checklist_template_items_update" ON checklist_template_items FOR UPDATE
  USING (
    (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  )
  WITH CHECK (
    (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "checklist_template_items_delete" ON checklist_template_items FOR DELETE
  USING (
    (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );


-- ============================================================
-- Table: checklist_template_sections
-- ============================================================
DROP POLICY IF EXISTS "template_sections_manage" ON checklist_template_sections;
DROP POLICY IF EXISTS "template_sections_select" ON checklist_template_sections;

CREATE POLICY "checklist_template_sections_select" ON checklist_template_sections FOR SELECT
  USING (
    ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE (checklist_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))))
  );

CREATE POLICY "checklist_template_sections_insert" ON checklist_template_sections FOR INSERT
  WITH CHECK (
    (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "checklist_template_sections_update" ON checklist_template_sections FOR UPDATE
  USING (
    (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  )
  WITH CHECK (
    (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "checklist_template_sections_delete" ON checklist_template_sections FOR DELETE
  USING (
    (template_id IN ( SELECT checklist_templates.id
   FROM checklist_templates
  WHERE is_org_member(checklist_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );


-- ============================================================
-- Table: checklist_templates
-- ============================================================
DROP POLICY IF EXISTS "checklist_templates_manage" ON checklist_templates;
DROP POLICY IF EXISTS "checklist_templates_select" ON checklist_templates;

CREATE POLICY "checklist_templates_select" ON checklist_templates FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "checklist_templates_insert" ON checklist_templates FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "checklist_templates_update" ON checklist_templates FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "checklist_templates_delete" ON checklist_templates FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: communication_logs
-- ============================================================
DROP POLICY IF EXISTS "comm_logs_manage" ON communication_logs;
DROP POLICY IF EXISTS "comm_logs_select" ON communication_logs;

CREATE POLICY "communication_logs_select" ON communication_logs FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "communication_logs_insert" ON communication_logs FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "communication_logs_update" ON communication_logs FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "communication_logs_delete" ON communication_logs FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: crew_availability
-- ============================================================
DROP POLICY IF EXISTS "crew_availability_manage" ON crew_availability;
DROP POLICY IF EXISTS "crew_availability_select" ON crew_availability;
DROP POLICY IF EXISTS "crew_availability_self_manage" ON crew_availability;

CREATE POLICY "crew_availability_select" ON crew_availability FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "crew_availability_insert" ON crew_availability FOR INSERT
  WITH CHECK (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))))
  );

CREATE POLICY "crew_availability_update" ON crew_availability FOR UPDATE
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))))
  )
  WITH CHECK (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))))
  );

CREATE POLICY "crew_availability_delete" ON crew_availability FOR DELETE
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))))
  );


-- ============================================================
-- Table: crew_members
-- ============================================================
DROP POLICY IF EXISTS "crew_manage" ON crew_members;
DROP POLICY IF EXISTS "crew_select" ON crew_members;
DROP POLICY IF EXISTS "crew_view_own" ON crew_members;

CREATE POLICY "crew_members_select" ON crew_members FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  OR ((user_id = auth.uid()))
  );

CREATE POLICY "crew_members_insert" ON crew_members FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "crew_members_update" ON crew_members FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "crew_members_delete" ON crew_members FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: integration_connections
-- ============================================================
DROP POLICY IF EXISTS "org_members_view_org_connections" ON integration_connections;
DROP POLICY IF EXISTS "users_view_own_connections" ON integration_connections;

CREATE POLICY "integration_connections_select" ON integration_connections FOR SELECT
  USING (
    ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  OR ((auth.uid() = user_id))
  );


-- ============================================================
-- Table: inventory_count_draft_items
-- ============================================================
DROP POLICY IF EXISTS "draft_items_insert" ON inventory_count_draft_items;
DROP POLICY IF EXISTS "draft_items_select" ON inventory_count_draft_items;
DROP POLICY IF EXISTS "icdi_manage" ON inventory_count_draft_items;
DROP POLICY IF EXISTS "icdi_select" ON inventory_count_draft_items;

CREATE POLICY "inventory_count_draft_items_select" ON inventory_count_draft_items FOR SELECT
  USING (
    ((draft_id IN ( SELECT d.id
   FROM inventory_count_drafts d
  WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((draft_id IN ( SELECT inventory_count_drafts.id
   FROM inventory_count_drafts
  WHERE (inventory_count_drafts.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))))
  );

CREATE POLICY "inventory_count_draft_items_insert" ON inventory_count_draft_items FOR INSERT
  WITH CHECK (
    ((draft_id IN ( SELECT d.id
   FROM inventory_count_drafts d
  WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((draft_id IN ( SELECT inventory_count_drafts.id
   FROM inventory_count_drafts
  WHERE (inventory_count_drafts.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))))
  );

CREATE POLICY "inventory_count_draft_items_update" ON inventory_count_draft_items FOR UPDATE
  USING (
    (draft_id IN ( SELECT d.id
   FROM inventory_count_drafts d
  WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  )
  WITH CHECK (
    (draft_id IN ( SELECT d.id
   FROM inventory_count_drafts d
  WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "inventory_count_draft_items_delete" ON inventory_count_draft_items FOR DELETE
  USING (
    (draft_id IN ( SELECT d.id
   FROM inventory_count_drafts d
  WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );


-- ============================================================
-- Table: inventory_count_drafts
-- ============================================================
DROP POLICY IF EXISTS "drafts_insert" ON inventory_count_drafts;
DROP POLICY IF EXISTS "drafts_manage" ON inventory_count_drafts;
DROP POLICY IF EXISTS "drafts_select" ON inventory_count_drafts;
DROP POLICY IF EXISTS "icd_manage" ON inventory_count_drafts;
DROP POLICY IF EXISTS "icd_select" ON inventory_count_drafts;

CREATE POLICY "inventory_count_drafts_select" ON inventory_count_drafts FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "inventory_count_drafts_insert" ON inventory_count_drafts FOR INSERT
  WITH CHECK (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "inventory_count_drafts_update" ON inventory_count_drafts FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "inventory_count_drafts_delete" ON inventory_count_drafts FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: inventory_items
-- ============================================================
DROP POLICY IF EXISTS "inventory_items_crew_select" ON inventory_items;
DROP POLICY IF EXISTS "inventory_items_manage" ON inventory_items;
DROP POLICY IF EXISTS "inventory_items_select" ON inventory_items;
DROP POLICY IF EXISTS "org members can insert inventory items" ON inventory_items;

CREATE POLICY "inventory_items_select" ON inventory_items FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((property_id IN ( SELECT DISTINCT t.property_id
   FROM ((turnovers t
     JOIN turnover_assignments ta ON ((ta.turnover_id = t.id)))
     JOIN crew_members cm ON ((ta.crew_member_id = cm.id)))
  WHERE (cm.user_id = auth.uid()))))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "inventory_items_insert" ON inventory_items FOR INSERT
  WITH CHECK (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "inventory_items_update" ON inventory_items FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "inventory_items_delete" ON inventory_items FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: inventory_template_items
-- ============================================================
DROP POLICY IF EXISTS "inventory_template_items_select" ON inventory_template_items;
DROP POLICY IF EXISTS "inventory_template_items_write" ON inventory_template_items;

CREATE POLICY "inventory_template_items_select" ON inventory_template_items FOR SELECT
  USING (
    ((template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE (inventory_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))))
  );

CREATE POLICY "inventory_template_items_insert" ON inventory_template_items FOR INSERT
  WITH CHECK (
    (template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "inventory_template_items_update" ON inventory_template_items FOR UPDATE
  USING (
    (template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  )
  WITH CHECK (
    (template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "inventory_template_items_delete" ON inventory_template_items FOR DELETE
  USING (
    (template_id IN ( SELECT inventory_templates.id
   FROM inventory_templates
  WHERE is_org_member(inventory_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );


-- ============================================================
-- Table: inventory_templates
-- ============================================================
DROP POLICY IF EXISTS "inventory_templates_select" ON inventory_templates;
DROP POLICY IF EXISTS "inventory_templates_write" ON inventory_templates;

CREATE POLICY "inventory_templates_select" ON inventory_templates FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "inventory_templates_insert" ON inventory_templates FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "inventory_templates_update" ON inventory_templates FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "inventory_templates_delete" ON inventory_templates FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: maintenance_schedule_template_items
-- ============================================================
DROP POLICY IF EXISTS "msti_manage" ON maintenance_schedule_template_items;
DROP POLICY IF EXISTS "msti_select" ON maintenance_schedule_template_items;

CREATE POLICY "maintenance_schedule_template_items_select" ON maintenance_schedule_template_items FOR SELECT
  USING (
    ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false)))))
  OR ((template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE ((maintenance_schedule_templates.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (maintenance_schedule_templates.is_system = true)))))
  );

CREATE POLICY "maintenance_schedule_template_items_insert" ON maintenance_schedule_template_items FOR INSERT
  WITH CHECK (
    (template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false))))
  );

CREATE POLICY "maintenance_schedule_template_items_update" ON maintenance_schedule_template_items FOR UPDATE
  USING (
    (template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false))))
  )
  WITH CHECK (
    (template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false))))
  );

CREATE POLICY "maintenance_schedule_template_items_delete" ON maintenance_schedule_template_items FOR DELETE
  USING (
    (template_id IN ( SELECT maintenance_schedule_templates.id
   FROM maintenance_schedule_templates
  WHERE (is_org_member(maintenance_schedule_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role]) AND (maintenance_schedule_templates.is_system = false))))
  );


-- ============================================================
-- Table: maintenance_schedule_templates
-- ============================================================
DROP POLICY IF EXISTS "mst_manage" ON maintenance_schedule_templates;
DROP POLICY IF EXISTS "mst_select" ON maintenance_schedule_templates;

CREATE POLICY "maintenance_schedule_templates_select" ON maintenance_schedule_templates FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR (((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)) OR (is_system = true)))
  );

CREATE POLICY "maintenance_schedule_templates_insert" ON maintenance_schedule_templates FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "maintenance_schedule_templates_update" ON maintenance_schedule_templates FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "maintenance_schedule_templates_delete" ON maintenance_schedule_templates FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: maintenance_schedules
-- ============================================================
DROP POLICY IF EXISTS "maintenance_manage" ON maintenance_schedules;
DROP POLICY IF EXISTS "maintenance_select" ON maintenance_schedules;

CREATE POLICY "maintenance_schedules_select" ON maintenance_schedules FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "maintenance_schedules_insert" ON maintenance_schedules FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "maintenance_schedules_update" ON maintenance_schedules FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "maintenance_schedules_delete" ON maintenance_schedules FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: org_milestones
-- ============================================================
DROP POLICY IF EXISTS "org_milestones_manage" ON org_milestones;
DROP POLICY IF EXISTS "org_milestones_select" ON org_milestones;

CREATE POLICY "org_milestones_select" ON org_milestones FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "org_milestones_insert" ON org_milestones FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  );

CREATE POLICY "org_milestones_update" ON org_milestones FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  );

CREATE POLICY "org_milestones_delete" ON org_milestones FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  );


-- ============================================================
-- Table: properties
-- ============================================================
DROP POLICY IF EXISTS "properties_manage" ON properties;
DROP POLICY IF EXISTS "properties_select" ON properties;

CREATE POLICY "properties_select" ON properties FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "properties_insert" ON properties FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "properties_update" ON properties FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "properties_delete" ON properties FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: property_assets
-- ============================================================
DROP POLICY IF EXISTS "assets_manage" ON property_assets;
DROP POLICY IF EXISTS "assets_select" ON property_assets;
DROP POLICY IF EXISTS "property_assets_select" ON property_assets;

CREATE POLICY "property_assets_select" ON property_assets FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "property_assets_insert" ON property_assets FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "property_assets_update" ON property_assets FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "property_assets_delete" ON property_assets FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: property_owners
-- ============================================================
DROP POLICY IF EXISTS "property_owners_org_read" ON property_owners;
DROP POLICY IF EXISTS "property_owners_org_write" ON property_owners;

CREATE POLICY "property_owners_select" ON property_owners FOR SELECT TO authenticated
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "property_owners_insert" ON property_owners FOR INSERT TO authenticated
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "property_owners_update" ON property_owners FOR UPDATE TO authenticated
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "property_owners_delete" ON property_owners FOR DELETE TO authenticated
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: purchase_orders
-- ============================================================
DROP POLICY IF EXISTS "purchase_orders_manage" ON purchase_orders;
DROP POLICY IF EXISTS "purchase_orders_org_read" ON purchase_orders;

CREATE POLICY "purchase_orders_select" ON purchase_orders FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "purchase_orders_insert" ON purchase_orders FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "purchase_orders_update" ON purchase_orders FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "purchase_orders_delete" ON purchase_orders FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: quote_requests
-- ============================================================
DROP POLICY IF EXISTS "quote_requests_org_read" ON quote_requests;
DROP POLICY IF EXISTS "quote_requests_org_write" ON quote_requests;

CREATE POLICY "quote_requests_select" ON quote_requests FOR SELECT TO authenticated
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "quote_requests_insert" ON quote_requests FOR INSERT TO authenticated
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "quote_requests_update" ON quote_requests FOR UPDATE TO authenticated
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "quote_requests_delete" ON quote_requests FOR DELETE TO authenticated
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: reviews
-- ============================================================
DROP POLICY IF EXISTS "Org members can read their reviews" ON reviews;
DROP POLICY IF EXISTS "reviews_service_write" ON reviews;

CREATE POLICY "reviews_select" ON reviews FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role]))
  OR ((org_id IN ( SELECT organization_members.org_id
   FROM organization_members
  WHERE (organization_members.user_id = auth.uid()))))
  );

CREATE POLICY "reviews_insert" ON reviews FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role])
  );

CREATE POLICY "reviews_update" ON reviews FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role])
  );

CREATE POLICY "reviews_delete" ON reviews FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'owner'::member_role])
  );


-- ============================================================
-- Table: turnover_assignments
-- ============================================================
DROP POLICY IF EXISTS "assignments_crew_select" ON turnover_assignments;
DROP POLICY IF EXISTS "assignments_manage" ON turnover_assignments;
DROP POLICY IF EXISTS "assignments_select" ON turnover_assignments;

CREATE POLICY "turnover_assignments_select" ON turnover_assignments FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((crew_member_id IN ( SELECT crew_members.id
   FROM crew_members
  WHERE (crew_members.user_id = auth.uid()))))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "turnover_assignments_insert" ON turnover_assignments FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "turnover_assignments_update" ON turnover_assignments FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "turnover_assignments_delete" ON turnover_assignments FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: turnovers
-- ============================================================
DROP POLICY IF EXISTS "turnovers_crew_select" ON turnovers;
DROP POLICY IF EXISTS "turnovers_crew_update" ON turnovers;
DROP POLICY IF EXISTS "turnovers_manage" ON turnovers;
DROP POLICY IF EXISTS "turnovers_select" ON turnovers;

CREATE POLICY "turnovers_select" ON turnovers FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((id IN ( SELECT get_crew_turnover_ids() AS get_crew_turnover_ids)))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "turnovers_insert" ON turnovers FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "turnovers_update" ON turnovers FOR UPDATE
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((id IN ( SELECT get_crew_turnover_ids() AS get_crew_turnover_ids)))
  )
  WITH CHECK (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((id IN ( SELECT get_crew_turnover_ids() AS get_crew_turnover_ids)))
  );

CREATE POLICY "turnovers_delete" ON turnovers FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: vendor_compliance_documents
-- ============================================================
DROP POLICY IF EXISTS "compliance_docs_manage" ON vendor_compliance_documents;
DROP POLICY IF EXISTS "compliance_docs_select" ON vendor_compliance_documents;
DROP POLICY IF EXISTS "vendor_compliance_documents_select" ON vendor_compliance_documents;

CREATE POLICY "vendor_compliance_documents_select" ON vendor_compliance_documents FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "vendor_compliance_documents_insert" ON vendor_compliance_documents FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "vendor_compliance_documents_update" ON vendor_compliance_documents FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "vendor_compliance_documents_delete" ON vendor_compliance_documents FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: vendors
-- ============================================================
DROP POLICY IF EXISTS "vendors_manage" ON vendors;
DROP POLICY IF EXISTS "vendors_select" ON vendors;

CREATE POLICY "vendors_select" ON vendors FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "vendors_insert" ON vendors FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "vendors_update" ON vendors FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "vendors_delete" ON vendors FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );


-- ============================================================
-- Table: work_order_photos
-- ============================================================
DROP POLICY IF EXISTS "wo_photos_manage" ON work_order_photos;
DROP POLICY IF EXISTS "wo_photos_select" ON work_order_photos;

CREATE POLICY "work_order_photos_select" ON work_order_photos FOR SELECT
  USING (
    ((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role]))))
  OR ((work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE (work_orders.org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))))
  );

CREATE POLICY "work_order_photos_insert" ON work_order_photos FOR INSERT
  WITH CHECK (
    (work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "work_order_photos_update" ON work_order_photos FOR UPDATE
  USING (
    (work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  )
  WITH CHECK (
    (work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );

CREATE POLICY "work_order_photos_delete" ON work_order_photos FOR DELETE
  USING (
    (work_order_id IN ( SELECT work_orders.id
   FROM work_orders
  WHERE is_org_member(work_orders.org_id, ARRAY['admin'::member_role, 'manager'::member_role])))
  );


-- ============================================================
-- Table: work_orders
-- ============================================================
DROP POLICY IF EXISTS "work_orders_manage" ON work_orders;
DROP POLICY IF EXISTS "work_orders_select" ON work_orders;

CREATE POLICY "work_orders_select" ON work_orders FOR SELECT
  USING (
    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  OR ((org_id IN ( SELECT get_user_org_ids() AS get_user_org_ids)))
  );

CREATE POLICY "work_orders_insert" ON work_orders FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "work_orders_update" ON work_orders FOR UPDATE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  )
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "work_orders_delete" ON work_orders FOR DELETE
  USING (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

