-- MEDIUM-9: communication_logs dedup was pure application-level (a SELECT
-- check before INSERT) with no unique index as a backstop — unlike every
-- other dedup in the codebase. Add a dedup_key column + partial unique index
-- so a retried Inngest step can't create a duplicate log row even under a
-- race between the check and the insert.
ALTER TABLE communication_logs ADD COLUMN IF NOT EXISTS dedup_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_logs_dedup_key
  ON communication_logs (dedup_key)
  WHERE dedup_key IS NOT NULL;
