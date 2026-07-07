
-- ─────────────────────────────────────────────────────────────────────────────
-- Guidebook trial period + revised sponsor thresholds
--
-- Adds trial_ends_at to guidebook_configurations:
--   - New orgs get 30 days of free Guidebook access from connection date
--   - After trial, requires 3 active sponsors (down from 4) to maintain access
--   - Credits remain at 5 sponsors ($10/mo) and 6 sponsors ($25/mo)
--   - Backfills existing configs so trial started at their created_at date
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE guidebook_configurations
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- Backfill existing rows: trial period starts from when the config was created
UPDATE guidebook_configurations
SET trial_ends_at = created_at + INTERVAL '30 days'
WHERE trial_ends_at IS NULL;
