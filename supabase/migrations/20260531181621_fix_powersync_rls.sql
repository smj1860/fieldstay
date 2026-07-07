
-- ============================================================
-- Fix: Enable RLS on PowerSync parameter tables
--
-- These tables had RLS disabled with zero policies, meaning
-- any authenticated user could read or write all rows.
--
-- These are parameter query tables used by PowerSync internally.
-- PowerSync's service-role connection bypasses RLS normally.
-- The policies below restrict direct client access correctly.
-- ============================================================

ALTER TABLE public.powersync_crew_turnovers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.powersync_crew_instances  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.powersync_crew_properties ENABLE ROW LEVEL SECURITY;

-- Each crew member can only read their own parameter rows.
-- No INSERT/UPDATE/DELETE policies = clients cannot write these tables.
-- All writes happen server-side via service_role.

CREATE POLICY "crew_select_own_turnovers"
  ON public.powersync_crew_turnovers
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "crew_select_own_instances"
  ON public.powersync_crew_instances
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "crew_select_own_properties"
  ON public.powersync_crew_properties
  FOR SELECT
  USING (auth.uid() = user_id);
