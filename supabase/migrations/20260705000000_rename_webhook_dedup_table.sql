-- ============================================================
-- Rename ownerrez_processed_webhooks → processed_webhooks
--
-- The dedup table is used for ALL integration providers, not
-- just OwnerRez. The misnamed table meant Hospitable webhook
-- rows were stored in ownerrez_processed_webhooks and never
-- TTL-cleaned (cleanup was guarded on providerId === 'ownerrez').
--
-- Strategy: create new table, copy live rows, drop old table.
-- Rows older than 72 hours are not worth migrating.
-- ============================================================

-- 1. Create the correctly-named table with identical schema
CREATE TABLE IF NOT EXISTS public.processed_webhooks (
  webhook_id   TEXT        PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processed_webhooks_processed_at_idx
  ON public.processed_webhooks (processed_at);

-- 2. Enable RLS — service role only; no PM should ever read this table
ALTER TABLE public.processed_webhooks ENABLE ROW LEVEL SECURITY;

-- No authenticated-role policies — this table is exclusively accessed
-- via the service role in the webhook route handler.
REVOKE ALL ON public.processed_webhooks FROM PUBLIC;
GRANT ALL  ON public.processed_webhooks TO service_role;

-- 3. Copy rows created in the last 72 hours (TTL window) to new table
-- Ignore conflicts in case of partial prior runs.
INSERT INTO public.processed_webhooks (webhook_id, processed_at)
SELECT webhook_id, processed_at
FROM   public.ownerrez_processed_webhooks
WHERE  processed_at > now() - INTERVAL '72 hours'
ON CONFLICT (webhook_id) DO NOTHING;

-- 4. Drop the old table — data is in the new table
DROP TABLE IF EXISTS public.ownerrez_processed_webhooks;

-- 5. Replace the cleanup function with the correctly-named version
--    that targets the new table
DROP FUNCTION IF EXISTS public.cleanup_ownerrez_webhook_dedup();

CREATE OR REPLACE FUNCTION public.cleanup_webhook_dedup()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.processed_webhooks
  WHERE processed_at < now() - INTERVAL '72 hours';
$$;

REVOKE ALL  ON FUNCTION public.cleanup_webhook_dedup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_webhook_dedup() TO service_role;

-- Force PostgREST to pick up the schema change immediately
NOTIFY pgrst, 'reload schema';
