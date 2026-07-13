-- Close the crew-suggestion learning loop.
--
-- assignment_outcomes today is write-only: suggested_score/score_breakdown/
-- duration_minutes get recorded, but nothing ever reads them back to move
-- crew_members.reliability_score/capacity_score off their static defaults,
-- and pm_rating is never populated by any UI. This adds the columns needed
-- for a nightly recompute cron to process each outcome exactly once.

ALTER TABLE assignment_outcomes
  ADD COLUMN IF NOT EXISTS was_late   BOOLEAN     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS was_missed BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scored_at  TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN assignment_outcomes.was_late IS
  'True if completed_at is after the turnover''s checkin_datetime (the next
   guest''s arrival). NULL until evaluated by the nightly crew-score-recompute
   cron, or for a missed assignment that never completed (see was_missed).';
COMMENT ON COLUMN assignment_outcomes.was_missed IS
  'True when a crew member was assigned to a turnover that went more than
   48 hours past its checkout with no completion — a dropped assignment,
   distinct from a late-but-completed one. Set by the nightly cron.';
COMMENT ON COLUMN assignment_outcomes.scored_at IS
  'Set by the crew-score-recompute cron once this outcome''s effect on
   crew_members.reliability_score/capacity_score has been applied — makes
   the recompute idempotent across cron runs instead of re-applying deltas.';

-- Speeds up the cron's "find outcomes not yet folded into a score" query.
CREATE INDEX IF NOT EXISTS idx_assignment_outcomes_unscored
  ON assignment_outcomes (crew_member_id)
  WHERE scored_at IS NULL AND (completed_at IS NOT NULL OR was_missed = true);
