-- Gates the new platform-admin surfaces (default seed content editor,
-- global inventory catalog editor) using the EXISTING platform_staff table
-- (added for the support inbox — see 20260630044706_support_bot_phase3_human_inbox.sql)
-- rather than a new table. platform_staff.role already distinguishes
-- 'support' from 'admin'; is_platform_staff() passes for either role, but
-- editing master template/catalog content is more sensitive than reading
-- the support inbox, so this is scoped to role = 'admin' specifically.
--
-- Named is_platform_staff_admin() rather than is_platform_admin() — there is
-- a SEPARATE, unrelated `platform_admins` table (see
-- 20260622121938_observability_platform_admin_tables.sql) gating cross-tenant
-- observability data (Inngest job runs, system health), explicitly never
-- meant to back a clickable app feature. This function has nothing to do
-- with that table; the distinct name avoids the two being confused later.

CREATE OR REPLACE FUNCTION public.is_platform_staff_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_staff
    WHERE user_id = auth.uid() AND role = 'admin'
  )
$$;

COMMENT ON FUNCTION public.is_platform_staff_admin IS
  'Returns true if the current user is platform_staff with role = admin.
   Distinct from is_platform_staff(), which passes for support staff too —
   used to gate the platform-admin editors (seed templates, inventory
   catalog), a more sensitive surface than the support inbox. Also distinct
   from the unrelated platform_admins table (observability access) — this
   function does not read that table.';

REVOKE EXECUTE ON FUNCTION public.is_platform_staff_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_platform_staff_admin() FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_platform_staff_admin() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.is_platform_staff_admin() TO service_role;
