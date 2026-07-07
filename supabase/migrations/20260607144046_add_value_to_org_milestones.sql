ALTER TABLE org_milestones
  ADD COLUMN IF NOT EXISTS value JSONB;

COMMENT ON COLUMN org_milestones.value IS
  'Optional JSON payload for milestones that carry result data,
   e.g. capex_projection_{year} stores the full projection tree.';
