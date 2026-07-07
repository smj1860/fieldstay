CREATE POLICY "org_master_checklist_items_select"
  ON public.org_master_checklist_items FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "org_master_maintenance_schedules_select"
  ON public.org_master_maintenance_schedules FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "owner_transactions_select"
  ON public.owner_transactions FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
