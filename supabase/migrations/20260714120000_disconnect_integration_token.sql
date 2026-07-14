-- Fix: deliberate Disconnect showed as "Error / Token revoked" indefinitely.
-- Root cause: disconnectIntegration() and involuntary webhook-driven
-- revocation both called revoke_integration_token(), setting status='revoked'
-- — there was no status meaning "user chose to disconnect" distinct from
-- "this connection died and needs urgent attention."
--
-- Allow 'disconnected' as a distinct status, separate from 'revoked'.
ALTER TABLE public.integration_connections
  DROP CONSTRAINT integration_connections_status_check;

ALTER TABLE public.integration_connections
  ADD CONSTRAINT integration_connections_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text, 'error'::text, 'disconnected'::text]));

-- Sibling to revoke_integration_token — identical secret-cleanup behavior,
-- sets 'disconnected' instead of 'revoked'. revoke_integration_token itself
-- is UNCHANGED and continues to be used by involuntary-revocation paths
-- (OwnerRez incremental sync, OwnerRez reviews sync, OwnerRez initial sync,
-- the token-refresh cron).
CREATE OR REPLACE FUNCTION public.disconnect_integration_token(p_user_id uuid, p_provider_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_secret_id         uuid;
  v_refresh_secret_id uuid;
BEGIN
  SELECT vault_secret_id, refresh_token_vault_secret_id
    INTO v_secret_id, v_refresh_secret_id
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  UPDATE public.integration_connections
  SET status                        = 'disconnected',
      vault_secret_id               = NULL,
      refresh_token_vault_secret_id = NULL,
      expires_at                    = NULL,
      updated_at                    = now()
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  IF v_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret_id;
  END IF;

  IF v_refresh_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_refresh_secret_id;
  END IF;
END;
$function$;

-- Match existing grants on revoke_integration_token (see
-- 20260531181701_integration_framework.sql): strip PUBLIC first — a bare
-- REVOKE FROM anon, authenticated leaves the default PUBLIC EXECUTE grant
-- in place, which anon/authenticated still pick up via PUBLIC.
REVOKE EXECUTE ON FUNCTION public.disconnect_integration_token(uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.disconnect_integration_token(uuid, text)
  TO service_role;
