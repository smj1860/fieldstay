ALTER TABLE communication_logs ADD COLUMN IF NOT EXISTS dedup_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_logs_dedup_key
  ON communication_logs (dedup_key)
  WHERE dedup_key IS NOT NULL;
