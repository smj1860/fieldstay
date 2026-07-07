CREATE INDEX IF NOT EXISTS idx_turnovers_checklist_template_id
  ON turnovers(checklist_template_id);

CREATE INDEX IF NOT EXISTS idx_checklist_instances_template_id
  ON checklist_instances(template_id);

CREATE INDEX IF NOT EXISTS idx_checklist_instance_items_completed_by_crew_id
  ON checklist_instance_items(completed_by_crew_id);

CREATE INDEX IF NOT EXISTS idx_inventory_items_catalog_item_id
  ON inventory_items(catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_inventory_counts_org_id
  ON inventory_counts(org_id);

CREATE INDEX IF NOT EXISTS idx_inventory_counts_submitted_by_crew_id
  ON inventory_counts(submitted_by_crew_id);

CREATE INDEX IF NOT EXISTS idx_inventory_count_items_inventory_item_id
  ON inventory_count_items(inventory_item_id);

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_inventory_item_id
  ON purchase_order_items(inventory_item_id);

CREATE INDEX IF NOT EXISTS idx_work_orders_assigned_crew_member_id
  ON work_orders(assigned_crew_member_id);

CREATE INDEX IF NOT EXISTS idx_work_orders_vendor_acknowledged_by
  ON work_orders(vendor_acknowledged_by);

CREATE INDEX IF NOT EXISTS idx_work_orders_vendor_id
  ON work_orders(vendor_id);

CREATE INDEX IF NOT EXISTS idx_work_orders_assigned_crew_id
  ON work_orders(assigned_crew_id);

CREATE INDEX IF NOT EXISTS idx_work_orders_asset_id
  ON work_orders(asset_id);

CREATE INDEX IF NOT EXISTS idx_work_orders_completion_verified_by
  ON work_orders(completion_verified_by);

CREATE INDEX IF NOT EXISTS idx_work_order_updates_org_id
  ON work_order_updates(org_id);

CREATE INDEX IF NOT EXISTS idx_work_order_updates_updated_by_user_id
  ON work_order_updates(updated_by_user_id);

CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_source_template_item_id
  ON maintenance_schedules(source_template_item_id);

CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_assigned_vendor_id
  ON maintenance_schedules(assigned_vendor_id);

CREATE INDEX IF NOT EXISTS idx_owner_transactions_purchase_order_id
  ON owner_transactions(purchase_order_id);

CREATE INDEX IF NOT EXISTS idx_owner_transactions_work_order_id
  ON owner_transactions(work_order_id);

CREATE INDEX IF NOT EXISTS idx_communication_logs_logged_by_user_id
  ON communication_logs(logged_by_user_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_org_id
  ON push_subscriptions(org_id);

CREATE INDEX IF NOT EXISTS idx_oauth_states_user_id
  ON oauth_states(user_id);

CREATE INDEX IF NOT EXISTS idx_review_responses_org_id
  ON review_responses(org_id);

CREATE INDEX IF NOT EXISTS idx_org_invites_invited_by
  ON org_invites(invited_by);

CREATE INDEX IF NOT EXISTS idx_inventory_count_draft_items_draft_id
  ON inventory_count_draft_items(draft_id);

CREATE INDEX IF NOT EXISTS idx_inventory_count_draft_items_item_id
  ON inventory_count_draft_items(item_id);

CREATE INDEX IF NOT EXISTS idx_inventory_template_items_catalog_item_id
  ON inventory_template_items(catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_inventory_template_items_template_id
  ON inventory_template_items(template_id);

CREATE INDEX IF NOT EXISTS idx_property_assets_replaced_by_asset_id
  ON property_assets(replaced_by_asset_id);

CREATE INDEX IF NOT EXISTS idx_maintenance_schedule_template_items_template_id
  ON maintenance_schedule_template_items(template_id);

CREATE INDEX IF NOT EXISTS idx_messages_turnover_id
  ON messages(turnover_id);

CREATE INDEX IF NOT EXISTS idx_messages_work_order_id
  ON messages(work_order_id);

CREATE INDEX IF NOT EXISTS idx_maintenance_completions_completed_by
  ON maintenance_completions(completed_by);
