
-- Task 15: Add SELECT policy for all org members on purchase_orders
-- (inventory_counts already has inventory_counts_select from a prior migration)
CREATE POLICY "purchase_orders_org_read" ON purchase_orders
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));
