-- ============================================================
-- Platform Staff: grants + RLS
--
-- The platform_staff table had no GRANT for the authenticated
-- role and no RLS policies, causing every query against it to
-- fail with "permission denied". This migration fixes both.
--
-- Access model:
--   authenticated users → SELECT their own row only
--   service role        → full access (manages staff membership)
--   no direct PM INSERT/UPDATE/DELETE via authenticated role
-- ============================================================

-- Ensure RLS is active
ALTER TABLE public.platform_staff ENABLE ROW LEVEL SECURITY;

-- Grant SELECT to authenticated role so the support inbox
-- gating check ("is this user platform staff?") can execute.
-- Write operations remain service-role only.
GRANT SELECT ON public.platform_staff TO authenticated;

-- Users may only read their own row — prevents any user from
-- discovering whether other users are platform staff.
DROP POLICY IF EXISTS "platform_staff_select_own" ON public.platform_staff;
CREATE POLICY "platform_staff_select_own"
  ON public.platform_staff
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies for authenticated role.
-- Staff membership is managed exclusively by the service role.
