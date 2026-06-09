-- OwnerRez webhook idempotency table
--
-- OwnerRez retries failed webhooks up to 10 times with exponential backoff.
-- A successful DB write that times out before the 2-second HTTP response window
-- will generate retries. This table deduplicates them using the `id` field
-- OwnerRez includes in every webhook payload.
--
-- Entries older than 72 hours are cleaned up by the webhook handler on each
-- request (the retry window is at most ~6 hours with 10 retries + backoff).

CREATE TABLE IF NOT EXISTS ownerrez_processed_webhooks (
  webhook_id   TEXT        PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index enables efficient range-delete for the 72-hour TTL cleanup
CREATE INDEX idx_ownerrez_webhooks_processed_at
  ON ownerrez_processed_webhooks (processed_at);

ALTER TABLE ownerrez_processed_webhooks ENABLE ROW LEVEL SECURITY;
-- No user-facing policies: this table is accessed exclusively via the service role,
-- which bypasses RLS. All user-level access is denied by default.
