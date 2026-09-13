-- ============================================================================
-- Friction Forecaster, Module 1 (Pre-Flight Audit)
--
-- Adds:
--   1. properties.seasonal_profile — the destination-type axis the seasonal
--      component keys off. Deliberately NOT the geography axis: spring break
--      timing is driven by where a property IS, and that is read from
--      properties.state in lib/scoring/friction.ts, never from here. Do not
--      add a 'spring_break' value to this enum.
--   2. pre_flight_friction — one scored row per turnover, written by the 2am
--      cron, read by the /ops exceptions panel.
--   3. crew_speed_baselines — the rolling 90-day minutes-per-bedroom rollup
--      the crew-duration component divides against.
-- ============================================================================

-- ── 1. seasonal_profile ─────────────────────────────────────────────────────
-- CREATE TYPE has no IF NOT EXISTS, so the DO block is what makes this file
-- re-runnable like every other migration in this directory.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'seasonal_profile') THEN
    CREATE TYPE seasonal_profile AS ENUM (
      'none',
      'summer_lake',
      'fall_foliage',
      'ski',
      'coastal_summer',
      'year_round_urban'
    );
  END IF;
END$$;

-- DEFAULT 'none' is load-bearing, not a formality: an unset profile must
-- contribute exactly 0 to the composite. A guessed default would silently
-- inflate the failure probability of every property nobody has classified.
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS seasonal_profile seasonal_profile NOT NULL DEFAULT 'none';

COMMENT ON COLUMN public.properties.seasonal_profile IS
  'Destination type, used by the friction forecaster''s seasonal component.
   Fixed MM-DD windows (lib/scoring/friction.ts SEASONAL_WINDOWS) — a rough
   internal ops proxy, never a customer-facing precision claim.';

-- ── 2. pre_flight_friction ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pre_flight_friction (
  id                  uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id              uuid         NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  turnover_id         uuid         NOT NULL REFERENCES public.turnovers(id)     ON DELETE CASCADE,
  property_id         uuid         NOT NULL REFERENCES public.properties(id)    ON DELETE CASCADE,
  turnover_date       date         NOT NULL,

  failure_probability numeric(4,3) NOT NULL
    CHECK (failure_probability >= 0 AND failure_probability <= 1),

  -- Always carries EVERY component key, including localEvents: 0, even though
  -- no local-events scorer exists. That key is the seam the future scorer
  -- drops into; omitting it when it is zero would make "not scored yet" and
  -- "scored at zero" indistinguishable in stored history.
  score_breakdown     jsonb        NOT NULL,

  severity            text         NOT NULL DEFAULT 'none'
    CHECK (severity IN ('none', 'high', 'critical')),
  status              text         NOT NULL DEFAULT 'flagged'
    CHECK (status IN ('flagged', 'resolved', 'dismissed')),

  -- ON DELETE SET NULL, not CASCADE: a crew member leaving the org must not
  -- delete the friction assessment of the turnover they were suggested for.
  -- The row stays, minus its Smart Fix.
  smart_fix_crew_id   uuid         REFERENCES public.crew_members(id) ON DELETE SET NULL,
  smart_fix_reasoning text,

  computed_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),

  -- One assessment per turnover. This is the cron's upsert conflict target,
  -- which is what makes a re-run (retry, or a second same-day run) rescore in
  -- place instead of accumulating duplicates.
  CONSTRAINT pre_flight_friction_turnover_unique UNIQUE (turnover_id)
);

-- The panel's own read: this org's flagged rows for a date, worst first.
CREATE INDEX IF NOT EXISTS pre_flight_friction_org_date_flagged_idx
  ON public.pre_flight_friction (org_id, turnover_date)
  WHERE status = 'flagged';

-- FK covering indexes. The partial index above does NOT count as org_id's
-- cover (it only indexes flagged rows), so org_id gets its own — this is
-- check 3 of scripts/check-db-invariants.mjs.
CREATE INDEX IF NOT EXISTS pre_flight_friction_org_id_idx
  ON public.pre_flight_friction (org_id);
CREATE INDEX IF NOT EXISTS pre_flight_friction_property_id_idx
  ON public.pre_flight_friction (property_id);
CREATE INDEX IF NOT EXISTS pre_flight_friction_smart_fix_crew_id_idx
  ON public.pre_flight_friction (smart_fix_crew_id);

-- CREATE OR REPLACE (not plain CREATE): this file must be re-runnable, and
-- CREATE TRIGGER has no IF NOT EXISTS.
CREATE OR REPLACE TRIGGER pre_flight_friction_updated_at
  BEFORE UPDATE ON public.pre_flight_friction
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.pre_flight_friction ENABLE ROW LEVEL SECURITY;

-- The GRANT is a separate prerequisite RLS depends on but does not replace:
-- Postgres checks it BEFORE any policy is evaluated, so a table with perfect
-- policies and no grant throws "permission denied" on every query.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.pre_flight_friction TO authenticated;

DROP POLICY IF EXISTS "pre_flight_friction_select" ON public.pre_flight_friction;
DROP POLICY IF EXISTS "pre_flight_friction_manage" ON public.pre_flight_friction;

-- Read/write split, mirroring vendor_assignment_outcomes: any org member can
-- SEE a flagged turnover, but accepting or dismissing one is the same
-- authority level as accepting a crew-assignment suggestion elsewhere.
CREATE POLICY "pre_flight_friction_select"
  ON public.pre_flight_friction FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "pre_flight_friction_manage"
  ON public.pre_flight_friction FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── 3. crew_speed_baselines ─────────────────────────────────────────────────
-- Rolling 90-day average, recomputed as the FIRST step of the same cron that
-- consumes it. Never a lifetime average: a cleaner who was slow while learning
-- the portfolio would carry that forever, and the window matches
-- FAMILIARITY_WINDOW_DAYS in auto-assign-turnover.ts.
CREATE TABLE IF NOT EXISTS public.crew_speed_baselines (
  crew_member_id          uuid         NOT NULL PRIMARY KEY
                            REFERENCES public.crew_members(id) ON DELETE CASCADE,
  org_id                  uuid         NOT NULL
                            REFERENCES public.organizations(id) ON DELETE CASCADE,
  avg_minutes_per_bedroom numeric(6,2) NOT NULL,
  sample_size             integer      NOT NULL,
  computed_at             timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crew_speed_baselines_org_id_idx
  ON public.crew_speed_baselines (org_id);

ALTER TABLE public.crew_speed_baselines ENABLE ROW LEVEL SECURITY;

-- SELECT only. The cron (service role) is the sole writer, so there is no
-- PM-facing write path to grant — unlike pre_flight_friction, whose
-- accept/dismiss buttons need one.
GRANT SELECT ON TABLE public.crew_speed_baselines TO authenticated;

DROP POLICY IF EXISTS "crew_speed_baselines_select" ON public.crew_speed_baselines;

CREATE POLICY "crew_speed_baselines_select"
  ON public.crew_speed_baselines FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
