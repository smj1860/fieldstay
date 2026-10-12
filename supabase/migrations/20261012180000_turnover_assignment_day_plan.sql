-- Phase E (item 1): the day planner.
--
-- A planned start and end for each crew member's turnovers, so the crew card
-- can show "when you are due to start" instead of checkout_datetime, which is
-- the GUEST'S departure time and reads like an arrival instruction.
--
-- ── Why these live on turnover_assignments, not on turnovers ──
-- The plan is a property of one crew member's DAY, not of the job. Two people
-- sharing a turnover each have their own sequence of other work around it, so
-- the same turnover can sit at a different point in each of their days. A
-- column on turnovers could hold only one answer and would silently pick a
-- winner.
--
-- ── plan_published_at is the whole safety design ──
-- A start time is an obligation. Computed and shown to a crew member with no
-- human in between, it makes them "behind" against a number nobody committed
-- to, and crew reliability is a real score in this product.
--
-- So the plan is computed freely and SHOWN TO CREW ONLY when a PM publishes
-- it. NULL means the PM has not published: the crew card keeps its existing
-- behaviour and sees no planned time at all.
--
-- This is also the seam for making it automatic later. "Publish" is a
-- timestamp written by a separate act rather than something baked into the
-- computation, so an org that wants the plan to go straight to crew needs the
-- planner to stamp this column itself, not a redesign. Deliberately NOT an
-- org-level mode enum today: a second mode nothing implements would read as a
-- capability the product has and does not.
--
-- ── What is NOT here ──
-- No planned_at. The plan is invalidated and recomputed whenever the inputs
-- move (an assignment changes, real dates change), so there is no window in
-- which a stale plan sits looking current, and planned_start_at already
-- carries the date it belongs to.
--
-- was_late is deliberately untouched. It stays `completed_at >
-- checkin_datetime` — measured against the guest actually arriving, which is
-- a bar that exists in the world. A planned start must not quietly become a
-- second, softer definition of late.

ALTER TABLE public.turnover_assignments
  ADD COLUMN IF NOT EXISTS planned_start_at   timestamptz,
  ADD COLUMN IF NOT EXISTS planned_end_at     timestamptz,
  ADD COLUMN IF NOT EXISTS plan_published_at  timestamptz;

-- End after start. Both null is the normal unplanned state; one without the
-- other is not a state the planner can produce, so it is rejected rather than
-- left to render as a half-plan.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnover_assignments_plan_window_valid'
  ) THEN
    ALTER TABLE public.turnover_assignments
      ADD CONSTRAINT turnover_assignments_plan_window_valid
      CHECK (
        (planned_start_at IS NULL AND planned_end_at IS NULL)
        OR (planned_start_at IS NOT NULL AND planned_end_at IS NOT NULL
            AND planned_end_at > planned_start_at)
      );
  END IF;
END $$;

-- The planner reads one crew member's day at a time, and the publish action
-- writes one crew member's day at a time. Partial: the overwhelming majority
-- of rows carry no plan, and an index over them would be mostly dead weight.
CREATE INDEX IF NOT EXISTS idx_turnover_assignments_crew_planned_start
  ON public.turnover_assignments (crew_member_id, planned_start_at)
  WHERE planned_start_at IS NOT NULL;

COMMENT ON COLUMN public.turnover_assignments.planned_start_at IS
  'Phase E. When this crew member is planned to start this turnover. Advisory until plan_published_at is set.';
COMMENT ON COLUMN public.turnover_assignments.plan_published_at IS
  'Phase E. Set when a PM publishes the day. NULL means crew see no planned time. The seam for a future auto-publish mode.';
