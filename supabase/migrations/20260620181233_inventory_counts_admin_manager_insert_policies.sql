CREATE POLICY "inventory_counts_admin_manager_insert"
  ON inventory_counts
  FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "count_items_admin_manager_insert"
  ON inventory_count_items
  FOR INSERT
  WITH CHECK (
    count_id IN (
      SELECT ic.id FROM inventory_counts ic
      WHERE is_org_member(ic.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  );
