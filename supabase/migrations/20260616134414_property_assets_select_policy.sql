CREATE POLICY "property_assets_select"
  ON public.property_assets FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
