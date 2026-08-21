-- FIXES A LIVE OUTAGE: vendor auto-suggestion has been failing with
-- Postgres 42501 ("permission denied for view vendor_compliance_status").
--
-- WHAT BROKE
--
-- public.vendor_compliance_status carried exactly two grants:
--
--   authenticated : SELECT
--   postgres      : ALL
--
-- and no `service_role` grant at all. Every other relation in `public` —
-- including `vendors` and `vendor_compliance_documents`, the two tables this
-- view is built from — has the full service_role set. It is the only one that
-- does not, verified by catalog sweep before writing this.
--
-- A GRANT is checked BEFORE RLS is ever evaluated, and service_role's
-- BYPASSRLS does nothing about a missing grant — bypassing row security is not
-- the same as being allowed to touch the object. So every service-role read of
-- this view failed outright:
--
--   lib/inngest/functions/auto-assign-vendor.ts:85   (the reported failure)
--   lib/vendors/compliance.ts        isVendorHardBlocked()
--   lib/notifications.ts             vendor-compliance notifications
--   lib/inngest/functions/cron/vendor-compliance-grace-check.ts
--
-- This is the same class as 20260710200000_grant_authenticated_missing_tables
-- — "perfect RLS policies, missing GRANT" — one role over. That migration
-- granted `authenticated` across the tables that were missing it. Nothing
-- granted `service_role` on this view, and nothing checked.
--
-- WHY IT SURFACED AS A SILENT FEATURE FAILURE
--
-- isVendorHardBlocked() FAILS CLOSED — it throws VendorComplianceCheckError
-- rather than returning false, on the correct principle that a compliance
-- check which cannot verify must never read as "allowed". That is the right
-- design and it did its job: no vendor was assigned in violation of a
-- hard block. The visible symptom was simply that vendor suggestions stopped
-- appearing, with the cause two Sentry errors deep.
--
-- SAFE
--
-- SELECT only, and the view is `security_invoker=true` (verified in the
-- catalog, not assumed), so it evaluates with the caller's privileges and RLS
-- on vendors / vendor_compliance_documents still applies to every other role.
-- service_role is intended to read across orgs — that is what the Inngest
-- functions above need.
GRANT SELECT ON public.vendor_compliance_status TO service_role;

-- ============================================================================
-- Introspection for the CI invariant that would have caught this.
--
-- Returns every relation in `public` that service_role cannot SELECT. The
-- correct answer is the empty set: service_role is the platform's own client,
-- and any object it cannot read is a 42501 waiting for the first Inngest
-- function that touches it.
--
-- Catalog-only — no DDL, no DML, never reads a table's rows — so it is safe to
-- point at production.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.service_role_grant_gaps()
RETURNS TABLE (
  relation  text,
  kind      text,
  has_authenticated_select boolean
)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $fn$
  SELECT
    c.relname::text,
    CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE c.relkind::text END,
    has_table_privilege('authenticated', c.oid, 'SELECT')
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'v', 'm')
    AND NOT has_table_privilege('service_role', c.oid, 'SELECT')
$fn$;

REVOKE ALL     ON FUNCTION public.service_role_grant_gaps() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.service_role_grant_gaps() TO service_role;

COMMENT ON FUNCTION public.service_role_grant_gaps() IS
  'Catalog-only. Every public relation service_role cannot SELECT — each one a latent 42501. Should always be empty.';
