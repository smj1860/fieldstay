
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.communication_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.maintenance_schedule_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.maintenance_schedule_template_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_availability TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_assets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asset_depreciation_entries TO authenticated;
GRANT SELECT ON TABLE public.asset_type_standards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.assignment_outcomes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_compliance_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_subscriptions TO authenticated;

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS city    text,
  ADD COLUMN IF NOT EXISTS state   text;
