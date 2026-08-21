-- Clear the captured webhook secret when a connection is disconnected or
-- revoked.
--
-- WHAT WAS WRONG
--
-- disconnect_integration_token() and revoke_integration_token() are the two
-- ways a connection loses its credentials — one voluntary (the PM clicks
-- Disconnect), one involuntary (the refresh cron gives up on a dead token).
-- Both null every OTHER credential on the row —
-- vault_secret_id, refresh_token_vault_secret_id, expires_at — and delete the
-- Vault secrets behind them. Both left `webhook_secret_hash` in place. That
-- column is the credential for the INBOUND direction, so tearing a connection
-- down invalidated everything we send and nothing we accept.
--
-- Harmless while down, because the route rejects on status before it
-- ever compares the hash. The damage lands on RECONNECT, and only for Hostex,
-- because Hostex is the one provider whose webhook secret is captured
-- trust-on-first-use rather than configured:
--
--   1. PM disconnects. webhook_token is deliberately RETAINED — rotating it
--      would orphan the URL already registered with Hostex and silently end
--      delivery (see lib/integrations/providers/hostex-webhook.ts).
--   2. PM reconnects, and authorizes a DIFFERENT Hostex account — a second
--      portfolio, a corrected login, an account migration.
--   3. ensureHostexWebhookRegistration registers the same URL on the new
--      account. Hostex mints a NEW secret for it, as it does for any new
--      registration.
--   4. Every delivery now carries a secret that does not match the hash we
--      captured from the OLD account, so app/api/webhooks/hostex/[token] 401s
--      all of them — permanently, since nothing rotates the stored hash.
--
-- The symptom is the worst kind: the connection is 'active', the daily
-- reconcile succeeds, the UI is green, and real-time updates simply never
-- arrive. The only trace is a steady drip of `webhook.hostex.secret-mismatch`
-- in Sentry, which reads as an attacker probing rather than as our own state
-- being stale.
--
-- THE FIX
--
-- Null the hash in both teardown paths, so a reconnect re-enters
-- trust-on-first-use and learns whatever secret the (possibly new) account is
-- actually sending.
--
-- This does NOT widen the TOFU window: a claim can only happen after the
-- status check passes, and a disconnected or revoked connection is refused
-- before the authentication block is reached. The window reopens exactly when
-- the PM reconnects, which is the same window the first connect had.
--
-- webhook_token is deliberately NOT cleared — see step 1 above.
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
      -- The inbound credential, cleared alongside the outbound ones. See the
      -- header for why webhook_token stays.
      webhook_secret_hash           = NULL,
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

-- The involuntary twin. Same body as before plus webhook_secret_hash, and the
-- same reasoning: a token the refresh cron gave up on is the MORE common way a
-- Hostex connection is torn down and later re-authorized, so leaving the hash
-- here would have made the fix above cover the rarer half of the problem.
CREATE OR REPLACE FUNCTION public.revoke_integration_token(p_user_id uuid, p_provider_id text)
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
  SET status                        = 'revoked',
      vault_secret_id               = NULL,
      refresh_token_vault_secret_id = NULL,
      expires_at                    = NULL,
      webhook_secret_hash           = NULL,
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
