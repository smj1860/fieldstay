CREATE POLICY "vendor_compliance_documents_select"
  ON public.vendor_compliance_documents FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
