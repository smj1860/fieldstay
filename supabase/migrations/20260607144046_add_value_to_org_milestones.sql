-- org_milestones was created outside tracked migration history (dashboard
-- DDL, backfilled later by the baseline schema snapshot), so a fresh replay
-- reaches this file before the table exists.
ALTER TABLE IF EXISTS org_milestones
  ADD COLUMN IF NOT EXISTS value JSONB;

DO $$
BEGIN
  IF to_regclass('public.org_milestones') IS NOT NULL THEN
    COMMENT ON COLUMN org_milestones.value IS
      'Optional JSON payload for milestones that carry result data,
       e.g. capex_projection_{year} stores the full projection tree.';
  END IF;
END $$;
