
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

-- Guarded with to_regclass() checks: these tables were created outside the
-- tracked migration history (dashboard DDL), so a fresh replay of this
-- migration history against an empty database — local dev, or `db push` to
-- a new project — reaches this file before the table exists. The tables
-- were dropped entirely by 20260611063549_drop_powersync_helper_views.sql
-- and 20260622123556_drop_dangling_powersync_crew_sync_triggers.sql, so
-- these guards are a no-op on any database where this migration's original
-- effect already landed — same statements, same result — and just make
-- fresh replay possible.

DO $$
BEGIN
  IF to_regclass('public.powersync_crew_turnovers') IS NOT NULL THEN
    ALTER TABLE public.powersync_crew_turnovers ENABLE ROW LEVEL SECURITY;
    -- Each crew member can only read their own parameter rows.
    -- No INSERT/UPDATE/DELETE policies = clients cannot write these tables.
    -- All writes happen server-side via service_role.
    CREATE POLICY "crew_select_own_turnovers"
      ON public.powersync_crew_turnovers
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF to_regclass('public.powersync_crew_instances') IS NOT NULL THEN
    ALTER TABLE public.powersync_crew_instances ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "crew_select_own_instances"
      ON public.powersync_crew_instances
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF to_regclass('public.powersync_crew_properties') IS NOT NULL THEN
    ALTER TABLE public.powersync_crew_properties ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "crew_select_own_properties"
      ON public.powersync_crew_properties
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;
