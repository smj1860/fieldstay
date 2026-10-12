-- Phase D (item 4): per-crew daily capacity.
--
-- Until now nothing in this product defined a maximum number of turnovers a
-- crew member may be given in a day. auto-assign-turnover.ts says so in a
-- comment and deliberately refuses to invent one: `capacity_score` is a 0-1
-- SCORING WEIGHT, not a limit, and a cleaner doing several turnovers in a day
-- is the normal case rather than over-booking. This column is the PM stating
-- the limit explicitly, which is what makes enforcing it a product decision
-- rather than an invented business rule.
--
-- NULLABLE, and null means NO LIMIT. Defaulting to a number would silently
-- change autopilot's behaviour for every existing org the moment it shipped,
-- refusing assignments it makes today. Nothing changes until a PM sets one.
--
-- Enforced as a HARD EXCLUSION rather than a score penalty, the same way
-- crew_availability already is: a weight can always be outvoted by proximity
-- and familiarity, and on the autopilot path there is no human in the loop to
-- catch the result.
--
-- max_minutes_per_day is deliberately NOT added here. A minutes budget needs a
-- per-turnover duration estimate to spend against it (crew_speed_baselines x
-- properties.bedrooms), which arrives with the day planner in Phase E. A
-- column nothing enforces would read as a capability the product has and does
-- not.

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS max_turnovers_per_day integer;

-- > 0, not >= 0. Zero is expressible two ways here and they mean different
-- things to a reader: a PM wanting to take someone out of auto-assignment has
-- auto_assign_eligible for exactly that, and it says what it means. A 0 here
-- would be a second, less obvious way to say the same thing, differing only in
-- that the crew member still shows up as a scored candidate who can never win.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crew_members_max_turnovers_per_day_positive'
  ) THEN
    ALTER TABLE public.crew_members
      ADD CONSTRAINT crew_members_max_turnovers_per_day_positive
      CHECK (max_turnovers_per_day IS NULL OR max_turnovers_per_day > 0);
  END IF;
END $$;

COMMENT ON COLUMN public.crew_members.max_turnovers_per_day IS
  'Phase D. Max turnovers this crew member may be auto-assigned or suggested for on one date. NULL = no limit. Hard exclusion in lib/inngest/functions/auto-assign-turnover.ts, not a score penalty.';
