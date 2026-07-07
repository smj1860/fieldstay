
-- Webhook deduplication table for OwnerRez
-- Prevents duplicate processing when OwnerRez retries webhook delivery
CREATE TABLE IF NOT EXISTS public.ownerrez_processed_webhooks (
  webhook_id   TEXT        NOT NULL PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the cleanup cron that purges old entries
CREATE INDEX IF NOT EXISTS idx_ownerrez_webhooks_processed_at
  ON public.ownerrez_processed_webhooks (processed_at);

-- Service role only — no user access needed
ALTER TABLE public.ownerrez_processed_webhooks ENABLE ROW LEVEL SECURITY;

-- No RLS policies needed — only service role touches this table
-- Revoke all PostgREST access (same pattern as oauth_states)
REVOKE ALL ON public.ownerrez_processed_webhooks FROM anon, authenticated;
