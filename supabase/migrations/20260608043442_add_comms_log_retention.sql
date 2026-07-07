ALTER TABLE communication_logs
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS comms_log_retention_days SMALLINT NOT NULL DEFAULT 365;

CREATE INDEX IF NOT EXISTS idx_comms_log_retention
  ON communication_logs(org_id, created_at)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN communication_logs.deleted_at IS
  'Soft-delete timestamp. NULL = active record visible to queries.
   Set by the daily retention cron when created_at is older than
   org.comms_log_retention_days. Hard-purged 30 days after soft-delete.';
