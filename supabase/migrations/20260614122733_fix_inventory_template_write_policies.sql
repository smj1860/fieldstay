
-- Task 11: Restrict inventory_template write access to admin/manager
-- Drop the overly-broad ALL-role policies
DROP POLICY IF EXISTS "org members can manage inventory templates"      ON inventory_templates;
DROP POLICY IF EXISTS "org members can manage inventory template items" ON inventory_template_items;

-- inventory_templates: SELECT for all org members, manage for admin/manager only
CREATE POLICY "inventory_templates_select" ON inventory_templates
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "inventory_templates_write" ON inventory_templates
  FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- inventory_template_items: SELECT via template join, manage for admin/manager only
CREATE POLICY "inventory_template_items_select" ON inventory_template_items
  FOR SELECT USING (
    template_id IN (
      SELECT id FROM inventory_templates
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "inventory_template_items_write" ON inventory_template_items
  FOR ALL
  USING (
    template_id IN (
      SELECT id FROM inventory_templates
      WHERE is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  )
  WITH CHECK (
    template_id IN (
      SELECT id FROM inventory_templates
      WHERE is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  );
