
-- ================================================================
-- CREW SCORING MODEL — Supporting Schema
-- 1. Property geocoordinates (proximity scoring)
-- 2. Crew member home location + derived score columns
-- 3. Assignment outcomes table (the learning loop)
-- ================================================================

-- 1. Property coordinates
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS lat  NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS lng  NUMERIC(9,6);

COMMENT ON COLUMN properties.lat IS
  'Geocoded latitude. Auto-populated from zip on property save via
   geocoding step in createProperty / updateProperty server action.
   Required for crew proximity scoring in auto-assignment algorithm.';
COMMENT ON COLUMN properties.lng IS 'Geocoded longitude. See properties.lat.';

-- 2. Crew member scoring fields
ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS home_lat          NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS home_lng          NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS reliability_score NUMERIC(4,3) NOT NULL DEFAULT 1.0
    CHECK (reliability_score BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS capacity_score    NUMERIC(4,3) NOT NULL DEFAULT 1.0
    CHECK (capacity_score BETWEEN 0 AND 1);

COMMENT ON COLUMN crew_members.home_lat IS
  'Home/start-of-day location. Used for proximity routing in
   the first assignment of the day when no other assignments exist yet.';
COMMENT ON COLUMN crew_members.reliability_score IS
  'Rolling 0–1 score. Starts at 1.0. Decays on late completions,
   missed assignments, or low PM ratings. Recovers on consistent
   on-time, high-rated completions. Weight = 0.05 in scoring formula.';
COMMENT ON COLUMN crew_members.capacity_score IS
  'Rolling 0–1 score representing affinity for larger properties.
   Derived from assignment_outcomes: ratio of large-property
   completions vs. small. Starts neutral at 1.0.';

-- 3. Assignment outcomes (the learning loop)
CREATE TABLE IF NOT EXISTS assignment_outcomes (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID        NOT NULL,
  turnover_id        UUID        NOT NULL REFERENCES turnovers(id)      ON DELETE CASCADE,
  crew_member_id     UUID        NOT NULL REFERENCES crew_members(id)   ON DELETE CASCADE,
  property_id        UUID        REFERENCES properties(id)              ON DELETE SET NULL,
  suggested_score    SMALLINT,            -- 0–100 score the algorithm assigned
  score_breakdown    JSONB,               -- { familiarity, workload, proximity, capacity, reliability }
  was_suggestion     BOOLEAN     NOT NULL DEFAULT false,
  was_accepted       BOOLEAN,             -- NULL = autopilot (no PM decision required)
  override_reason    TEXT,
  started_at         TIMESTAMPTZ,         -- first checklist item timestamp
  completed_at       TIMESTAMPTZ,         -- last checklist item timestamp
  duration_minutes   INTEGER              -- computed: completed - started, capped at 480 min
    GENERATED ALWAYS AS (
      CASE
        WHEN started_at IS NOT NULL AND completed_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (completed_at - started_at)) / 60 <= 480
        THEN EXTRACT(EPOCH FROM (completed_at - started_at)) / 60::INTEGER
        ELSE NULL  -- anomalous duration excluded from scoring
      END
    ) STORED,
  pm_rating          SMALLINT    CHECK (pm_rating BETWEEN 1 AND 5),
  property_bedrooms  SMALLINT,            -- snapshot at time of assignment
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (turnover_id, crew_member_id)    -- one outcome row per crew per turnover
);

CREATE INDEX idx_assignment_outcomes_crew
  ON assignment_outcomes(crew_member_id, completed_at DESC);

CREATE INDEX idx_assignment_outcomes_property_crew
  ON assignment_outcomes(property_id, crew_member_id)
  WHERE duration_minutes IS NOT NULL;

ALTER TABLE assignment_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assignment_outcomes_select"
  ON assignment_outcomes FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "assignment_outcomes_manage"
  ON assignment_outcomes FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
