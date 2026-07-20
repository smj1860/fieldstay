-- Splits the "<table>_manage FOR ALL" policy on 10 tables into separate
-- INSERT/UPDATE/DELETE policies. Each of these tables already has its own
-- "<table>_select" policy whose qual is `org_id IN (SELECT get_user_org_ids())`
-- (or the equivalent join for room_template_items) — a strict superset of
-- the manage policy's `is_org_member(org_id, ARRAY[...])` qual, since every
-- org member matched by is_org_member() is by definition also counted by
-- get_user_org_ids(). So the manage policy's SELECT coverage was always
-- fully redundant with the select policy — Postgres evaluates every
-- matching PERMISSIVE policy and ORs the results, so every SELECT on these
-- tables was doing two RLS subquery evaluations for no additional access.
--
-- Postgres's CREATE POLICY only accepts a single command per policy (no
-- "FOR INSERT, UPDATE, DELETE" list), so each FOR ALL policy becomes three
-- policies below rather than one.
--
-- Scoped to only the tables where the manage/select relationship is this
-- simple, provable superset case. crew_feedback, checklist_instances,
-- work_orders, property_assets, platform_staff, push_subscriptions,
-- support_conversations, support_messages, inventory_counts, and
-- inventory_count_items were deliberately left untouched — each has
-- multiple SELECT/UPDATE/INSERT policies for genuinely distinct actor
-- scopes (crew vs. admin, platform staff vs. org member) where collapsing
-- policies risks a real authorization regression, not just a performance one.

-- ── asset_manuals ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "asset_manuals_manage" ON asset_manuals;
DROP POLICY IF EXISTS "asset_manuals_insert" ON asset_manuals;
DROP POLICY IF EXISTS "asset_manuals_update" ON asset_manuals;
DROP POLICY IF EXISTS "asset_manuals_delete" ON asset_manuals;

CREATE POLICY "asset_manuals_insert" ON asset_manuals FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "asset_manuals_update" ON asset_manuals FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "asset_manuals_delete" ON asset_manuals FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── guidebook_guest_sms_optins ──────────────────────────────────────────
DROP POLICY IF EXISTS "gso_org_members_manage" ON guidebook_guest_sms_optins;
DROP POLICY IF EXISTS "guidebook_guest_sms_optins_insert" ON guidebook_guest_sms_optins;
DROP POLICY IF EXISTS "guidebook_guest_sms_optins_update" ON guidebook_guest_sms_optins;
DROP POLICY IF EXISTS "guidebook_guest_sms_optins_delete" ON guidebook_guest_sms_optins;

CREATE POLICY "guidebook_guest_sms_optins_insert" ON guidebook_guest_sms_optins FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "guidebook_guest_sms_optins_update" ON guidebook_guest_sms_optins FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "guidebook_guest_sms_optins_delete" ON guidebook_guest_sms_optins FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── guidebook_property_configs ──────────────────────────────────────────
DROP POLICY IF EXISTS "gpc_org_members_manage" ON guidebook_property_configs;
DROP POLICY IF EXISTS "guidebook_property_configs_insert" ON guidebook_property_configs;
DROP POLICY IF EXISTS "guidebook_property_configs_update" ON guidebook_property_configs;
DROP POLICY IF EXISTS "guidebook_property_configs_delete" ON guidebook_property_configs;

CREATE POLICY "guidebook_property_configs_insert" ON guidebook_property_configs FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "guidebook_property_configs_update" ON guidebook_property_configs FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "guidebook_property_configs_delete" ON guidebook_property_configs FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── org_master_checklist_items ──────────────────────────────────────────
DROP POLICY IF EXISTS "Admins and managers manage master checklist" ON org_master_checklist_items;
DROP POLICY IF EXISTS "org_master_checklist_items_insert" ON org_master_checklist_items;
DROP POLICY IF EXISTS "org_master_checklist_items_update" ON org_master_checklist_items;
DROP POLICY IF EXISTS "org_master_checklist_items_delete" ON org_master_checklist_items;

CREATE POLICY "org_master_checklist_items_insert" ON org_master_checklist_items FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
CREATE POLICY "org_master_checklist_items_update" ON org_master_checklist_items FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
CREATE POLICY "org_master_checklist_items_delete" ON org_master_checklist_items FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

-- ── org_master_maintenance_schedules ────────────────────────────────────
DROP POLICY IF EXISTS "Admins managers owners manage master maintenance" ON org_master_maintenance_schedules;
DROP POLICY IF EXISTS "org_master_maintenance_schedules_insert" ON org_master_maintenance_schedules;
DROP POLICY IF EXISTS "org_master_maintenance_schedules_update" ON org_master_maintenance_schedules;
DROP POLICY IF EXISTS "org_master_maintenance_schedules_delete" ON org_master_maintenance_schedules;

CREATE POLICY "org_master_maintenance_schedules_insert" ON org_master_maintenance_schedules FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
CREATE POLICY "org_master_maintenance_schedules_update" ON org_master_maintenance_schedules FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
CREATE POLICY "org_master_maintenance_schedules_delete" ON org_master_maintenance_schedules FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

-- ── owner_transactions ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "owner_transactions_manage" ON owner_transactions;
DROP POLICY IF EXISTS "owner_transactions_insert" ON owner_transactions;
DROP POLICY IF EXISTS "owner_transactions_update" ON owner_transactions;
DROP POLICY IF EXISTS "owner_transactions_delete" ON owner_transactions;

CREATE POLICY "owner_transactions_insert" ON owner_transactions FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "owner_transactions_update" ON owner_transactions FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "owner_transactions_delete" ON owner_transactions FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── room_template_items ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "room_template_items_manage" ON room_template_items;
DROP POLICY IF EXISTS "room_template_items_insert" ON room_template_items;
DROP POLICY IF EXISTS "room_template_items_update" ON room_template_items;
DROP POLICY IF EXISTS "room_template_items_delete" ON room_template_items;

CREATE POLICY "room_template_items_insert" ON room_template_items FOR INSERT
  WITH CHECK (room_template_id IN (
    SELECT room_templates.id FROM room_templates
    WHERE is_org_member(room_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  ));
CREATE POLICY "room_template_items_update" ON room_template_items FOR UPDATE
  USING (room_template_id IN (
    SELECT room_templates.id FROM room_templates
    WHERE is_org_member(room_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  ))
  WITH CHECK (room_template_id IN (
    SELECT room_templates.id FROM room_templates
    WHERE is_org_member(room_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  ));
CREATE POLICY "room_template_items_delete" ON room_template_items FOR DELETE
  USING (room_template_id IN (
    SELECT room_templates.id FROM room_templates
    WHERE is_org_member(room_templates.org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  ));

-- ── room_templates ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "room_templates_manage" ON room_templates;
DROP POLICY IF EXISTS "room_templates_insert" ON room_templates;
DROP POLICY IF EXISTS "room_templates_update" ON room_templates;
DROP POLICY IF EXISTS "room_templates_delete" ON room_templates;

CREATE POLICY "room_templates_insert" ON room_templates FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
CREATE POLICY "room_templates_update" ON room_templates FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));
CREATE POLICY "room_templates_delete" ON room_templates FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

-- ── vendor_assignment_outcomes ───────────────────────────────────────────
DROP POLICY IF EXISTS "vendor_assignment_outcomes_manage" ON vendor_assignment_outcomes;
DROP POLICY IF EXISTS "vendor_assignment_outcomes_insert" ON vendor_assignment_outcomes;
DROP POLICY IF EXISTS "vendor_assignment_outcomes_update" ON vendor_assignment_outcomes;
DROP POLICY IF EXISTS "vendor_assignment_outcomes_delete" ON vendor_assignment_outcomes;

CREATE POLICY "vendor_assignment_outcomes_insert" ON vendor_assignment_outcomes FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "vendor_assignment_outcomes_update" ON vendor_assignment_outcomes FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "vendor_assignment_outcomes_delete" ON vendor_assignment_outcomes FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── work_order_invoices ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "work_order_invoices_manage" ON work_order_invoices;
DROP POLICY IF EXISTS "work_order_invoices_insert" ON work_order_invoices;
DROP POLICY IF EXISTS "work_order_invoices_update" ON work_order_invoices;
DROP POLICY IF EXISTS "work_order_invoices_delete" ON work_order_invoices;

CREATE POLICY "work_order_invoices_insert" ON work_order_invoices FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "work_order_invoices_update" ON work_order_invoices FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
CREATE POLICY "work_order_invoices_delete" ON work_order_invoices FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── vendor_compliance_documents.org_id index ────────────────────────────
-- The only org_id-touching index on this table was a partial one excluding
-- rows without expiry_date, so every RLS check and .eq('org_id', ...)
-- query fell back to a sequential scan.
CREATE INDEX IF NOT EXISTS idx_vendor_compliance_documents_org_id
  ON vendor_compliance_documents (org_id);
