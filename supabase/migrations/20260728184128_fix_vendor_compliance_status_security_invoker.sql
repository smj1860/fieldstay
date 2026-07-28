-- Fixes a live cross-tenant data leak: vendor_compliance_status was
-- SECURITY DEFINER with no org_id filter and SELECT granted to
-- `authenticated`, so any signed-in user of any org could read every
-- other org's vendor roster via a direct PostgREST call. Both underlying
-- tables (vendors, vendor_compliance_documents) already have correct
-- org-scoped RLS SELECT policies (org_id IN get_user_org_ids()), so
-- switching this view to invoker semantics is sufficient — no view
-- definition change needed, and service_role callers (BYPASSRLS) are
-- unaffected either way.
ALTER VIEW public.vendor_compliance_status SET (security_invoker = true);
