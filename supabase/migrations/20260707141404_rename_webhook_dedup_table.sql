-- Fix production/repo drift: the deployed webhook handler
-- (app/api/webhooks/[provider]/route.ts) writes to `processed_webhooks` and
-- calls cleanup_webhook_dedup(), but prod still had the OwnerRez-specific table.
-- Result: webhook de-duplication was silently failing for ALL providers.

-- 1. Correctly-named, provider-agnostic dedup table
CREATE TABLE IF NOT EXISTS public.processed_webhooks (
  webhook_id   TEXT        PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processed_webhooks_processed_at_idx
  ON public.processed_webhooks (processed_at);

ALTER TABLE public.processed_webhooks ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.processed_webhooks IS
  'Idempotency ledger for ALL inbound provider webhooks. Keyed as "<provider>:<webhook_id>". '
  'RLS enabled, no policies by design — service_role only (webhook route handler). TTL 72h via cleanup_webhook_dedup().';

REVOKE ALL ON public.processed_webhooks FROM PUBLIC;
GRANT  ALL ON public.processed_webhooks TO service_role;

-- 2. Carry over recent rows (last 72h) if the legacy table still exists
DO $$
BEGIN
  IF to_regclass('public.ownerrez_processed_webhooks') IS NOT NULL THEN
    INSERT INTO public.processed_webhooks (webhook_id, processed_at)
    SELECT webhook_id, processed_at
    FROM   public.ownerrez_processed_webhooks
    WHERE  processed_at > now() - INTERVAL '72 hours'
    ON CONFLICT (webhook_id) DO NOTHING;
  END IF;
END $$;

-- 3. Drop the legacy table
DROP TABLE IF EXISTS public.ownerrez_processed_webhooks;

-- 4. Replace the cleanup function with the correctly-named, generic version
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

REVOKE ALL     ON FUNCTION public.cleanup_webhook_dedup() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cleanup_webhook_dedup() TO service_role;

NOTIFY pgrst, 'reload schema';
